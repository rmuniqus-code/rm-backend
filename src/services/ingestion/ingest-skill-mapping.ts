/**
 * Skill Mapping Ingestion Pipeline
 *
 * Flow:
 *   1. Parse Excel → SkillMappingRow[]
 *   2. Build lookup caches (skills, sectors, employees)
 *   3. For each employee row:
 *        a. Resolve employee UUID (by employee_id then email)
 *        b. Build employee_skills inserts (primary + deduped secondary)
 *        c. Build employee_sectors inserts (secondary free-text)
 *        d. Queue primary_sector_id update
 *   4. Batch upsert employee_skills  (onConflict: employee_id, skill_id)
 *   5. Batch upsert employee_sectors (onConflict: employee_id, raw_name)
 *   6. Batch update employees.primary_sector_id
 *   7. Log the upload
 *
 * Idempotent: re-uploading replaces skill data (upsert on unique keys).
 * Employees not already in the DB are skipped with an error entry.
 */

import { getSupabase } from './ingest'
import { parseSkillMappingExcel, buildSecondarySkillList } from './parse-skill-mapping'
import type { ValidationError } from './parse-excel'

// ─── Types ────────────────────────────────────────────────────

export interface SkillMappingIngestionResult {
  uploadId: string
  fileType: 'skill_mapping'
  totalRows: number
  successCount: number
  errorCount: number
  errors: ValidationError[]
  duration: number
}

// ─── Cache ───────────────────────────────────────────────────

interface SkillMappingCache {
  skills: Map<string, string>    // name → uuid
  sectors: Map<string, string>   // name → uuid
  empById: Map<string, string>   // employee_id → uuid
  empByEmail: Map<string, string> // email (lower) → uuid
}

async function buildCache(): Promise<SkillMappingCache> {
  const sb = getSupabase()

  const [skillsRes, sectorsRes, empRes] = await Promise.all([
    sb.from('skills').select('id, name'),
    sb.from('sectors').select('id, name'),
    sb.from('employees').select('id, employee_id, email'),
  ])

  if (skillsRes.error) throw new Error(`skills fetch: ${skillsRes.error.message}`)
  if (sectorsRes.error) throw new Error(`sectors fetch: ${sectorsRes.error.message}`)
  if (empRes.error) throw new Error(`employees fetch: ${empRes.error.message}`)

  const cache: SkillMappingCache = {
    skills:    new Map((skillsRes.data ?? []).map(s => [s.name, s.id])),
    sectors:   new Map((sectorsRes.data ?? []).map(s => [s.name, s.id])),
    empById:   new Map((empRes.data ?? []).map(e => [e.employee_id, e.id])),
    empByEmail: new Map(
      (empRes.data ?? [])
        .filter(e => e.email)
        .map(e => [e.email.toLowerCase(), e.id]),
    ),
  }

  return cache
}

// ─── Batch helpers ───────────────────────────────────────────

const CHUNK = 500

async function upsertChunked<T extends object>(
  table: string,
  rows: T[],
  onConflict: string,
): Promise<void> {
  const sb = getSupabase()
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await sb.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`${table} upsert failed: ${error.message}`)
  }
}

// ─── Main ingest function ────────────────────────────────────

export async function ingestSkillMappingFile(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<SkillMappingIngestionResult> {
  const startTime = Date.now()
  const sb = getSupabase()

  // ── 1. Parse Excel ───────────────────────────────────────────
  const rows = parseSkillMappingExcel(buffer)

  // ── 2. Create upload log (in-progress) ──────────────────────
  const { data: logData, error: logError } = await sb
    .from('upload_logs')
    .insert({
      file_name: fileName,
      file_type: 'skill_mapping',
      row_count: rows.length,
      status: 'processing',
    })
    .select('id')
    .single()

  if (logError) throw new Error(`upload_logs insert: ${logError.message}`)
  const uploadId: string = logData.id

  // ── 3. Build caches ──────────────────────────────────────────
  const cache = await buildCache()

  if (cache.skills.size === 0) {
    throw new Error('skills table is empty — run migration 004_skill_mapping.sql first')
  }

  // ── 4. Process rows ──────────────────────────────────────────

  const empSkillsInsert: {
    employee_id: string
    skill_id: string
    skill_type: string
    skill_order: number
  }[] = []

  const empSectorsInsert: {
    employee_id: string
    sector_id: string | null
    raw_name: string
  }[] = []

  const primarySectorUpdates: { uuid: string; sectorId: string | null }[] = []

  const errors: ValidationError[] = []
  let successCount = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const rowNum = i + 2 // 1-indexed, +1 for header

    // Resolve employee
    const employeeUuid =
      cache.empById.get(row.employeeId) ??
      cache.empByEmail.get(row.email.toLowerCase())

    if (!employeeUuid) {
      errors.push({
        row: rowNum,
        field: 'Employee ID / Email',
        value: row.employeeId || row.email,
        message: `Employee not found in database (ID: ${row.employeeId}, email: ${row.email})`,
      })
      continue
    }

    // Primary skill
    if (row.primarySkill) {
      const skillId = cache.skills.get(row.primarySkill)
      if (!skillId) {
        errors.push({
          row: rowNum,
          field: 'Primary Skillset',
          value: row.primarySkill,
          message: `Unknown skill "${row.primarySkill}"`,
        })
      } else {
        empSkillsInsert.push({
          employee_id: employeeUuid,
          skill_id: skillId,
          skill_type: 'primary',
          skill_order: 1,
        })
      }
    }

    // Secondary skills (merged + deduped secondary + tertiary)
    for (const { skillName, order } of buildSecondarySkillList(
      row.primarySkill,
      row.secondarySkills,
      row.tertiarySkills,
    )) {
      const skillId = cache.skills.get(skillName)
      if (!skillId) {
        errors.push({
          row: rowNum,
          field: 'Secondary/Tertiary Skillset',
          value: skillName,
          message: `Unknown skill "${skillName}"`,
        })
        continue
      }
      empSkillsInsert.push({
        employee_id: employeeUuid,
        skill_id: skillId,
        skill_type: 'secondary',
        skill_order: order,
      })
    }

    // Primary sector
    const primarySectorId = row.primarySector
      ? (cache.sectors.get(row.primarySector) ?? null)
      : null
    primarySectorUpdates.push({ uuid: employeeUuid, sectorId: primarySectorId })

    // Secondary sectors (free-text)
    for (const raw of row.secondarySectors) {
      empSectorsInsert.push({
        employee_id: employeeUuid,
        sector_id: cache.sectors.get(raw) ?? null,
        raw_name: raw,
      })
    }

    successCount++
  }

  // ── 5. Upsert employee_skills ────────────────────────────────
  if (empSkillsInsert.length > 0) {
    await upsertChunked('employee_skills', empSkillsInsert, 'employee_id,skill_id')
  }

  // ── 6. Upsert employee_sectors ───────────────────────────────
  if (empSectorsInsert.length > 0) {
    await upsertChunked('employee_sectors', empSectorsInsert, 'employee_id,raw_name')
  }

  // ── 7. Update employees.primary_sector_id ───────────────────
  // Batch: group by sector_id to minimise round trips
  if (primarySectorUpdates.length > 0) {
    // Group employee UUIDs by target sector_id (null or UUID)
    const bySector = new Map<string | null, string[]>()
    for (const { uuid, sectorId } of primarySectorUpdates) {
      const key = sectorId ?? '__null__'
      if (!bySector.has(key)) bySector.set(key, [])
      bySector.get(key)!.push(uuid)
    }

    for (const [key, uuids] of bySector) {
      const sectorId = key === '__null__' ? null : key
      for (let i = 0; i < uuids.length; i += CHUNK) {
        const chunk = uuids.slice(i, i + CHUNK)
        const { error } = await sb
          .from('employees')
          .update({ primary_sector_id: sectorId })
          .in('id', chunk)
        if (error) {
          console.error(`[skill-mapping] primary_sector update failed: ${error.message}`)
        }
      }
    }
  }

  // ── 8. Finalise upload log ───────────────────────────────────
  const duration = Date.now() - startTime
  const cappedErrors = errors.slice(0, 100)

  await sb
    .from('upload_logs')
    .update({
      success_count: successCount,
      error_count: errors.length,
      errors: cappedErrors,
      status: errors.length === rows.length && rows.length > 0 ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', uploadId)

  return {
    uploadId,
    fileType: 'skill_mapping',
    totalRows: rows.length,
    successCount,
    errorCount: errors.length,
    errors: cappedErrors,
    duration,
  }
}
