/**
 * Forecast Tracker Ingestion Pipeline
 *
 * Flow:
 *   1. Parse Excel → ForecastRow[]  (done by parse-forecast.ts)
 *   2. Upsert employees (master data + new fields)
 *   3. Resolve/create projects from allocation text
 *   4. Insert forecast_allocations (delete-and-replace per employee)
 *   5. Insert utilization_snapshots
 *   6. Log the upload
 *
 * Design:
 *   - Idempotent: re-uploading replaces existing forecast data
 *   - Lookup-first: projects resolved from free text before FK insert
 *   - Batched: rows processed in batches of 50
 */

import { getSupabase } from './ingest'
import { parseForecastExcel } from './parse-forecast'
import type { ForecastRow, AllocationEntry } from './parse-forecast'
import type { ValidationError } from './parse-excel'

// ─── Types ───────────────────────────────────────────────────

interface ForecastIngestionResult {
  uploadId: string
  fileType: 'forecast_tracker'
  totalRows: number
  successCount: number
  errorCount: number
  errors: ValidationError[]
  weekRange: { start: string; end: string } | null
  duration: number
}

// Caches populated once per upload
interface ForecastCache {
  designations: Map<string, string>     // name → uuid
  subFunctions: Map<string, string>     // name → uuid
  locations: Map<string, string>        // name → uuid
  departments: Map<string, string>      // name → uuid
  employees: Map<string, string>        // employee_id → uuid
  projects: Map<string, string>         // normalized project name → uuid
}

// ─── Normalize project name for dedup ────────────────────────

function normalizeProjectName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

// ─── Map project type text → DB enum value ───────────────────

function mapProjectType(type: string | null): string {
  if (!type) return 'chargeable'
  const lower = type.toLowerCase().trim()
  if (lower === 'chargeable') return 'chargeable'
  if (lower === 'non-chargeable' || lower === 'non chargeable') return 'non_chargeable'
  if (lower === 'internal') return 'internal'
  if (lower === 'training') return 'training'
  return 'chargeable'
}

// ─── Build caches ────────────────────────────────────────────

async function buildForecastCache(): Promise<ForecastCache> {
  const sb = getSupabase()
  const cache: ForecastCache = {
    designations: new Map(),
    subFunctions: new Map(),
    locations: new Map(),
    departments: new Map(),
    employees: new Map(),
    projects: new Map(),
  }

  const [desigs, subs, locs, depts, emps, projs] = await Promise.all([
    sb.from('designations').select('id, name'),
    sb.from('sub_functions').select('id, name'),
    sb.from('locations').select('id, name'),
    sb.from('departments').select('id, name'),
    sb.from('employees').select('id, employee_id'),
    sb.from('projects').select('id, name'),
  ])

  desigs.data?.forEach((r: { id: string; name: string }) => cache.designations.set(r.name, r.id))
  subs.data?.forEach((r: { id: string; name: string }) => cache.subFunctions.set(r.name, r.id))
  locs.data?.forEach((r: { id: string; name: string }) => cache.locations.set(r.name, r.id))
  depts.data?.forEach((r: { id: string; name: string }) => cache.departments.set(r.name, r.id))
  emps.data?.forEach((r: { id: string; employee_id: string }) => cache.employees.set(r.employee_id, r.id))
  projs.data?.forEach((r: { id: string; name: string }) => cache.projects.set(normalizeProjectName(r.name), r.id))

  return cache
}

// ─── Resolve or create a lookup record ───────────────────────

async function resolveOrCreate(
  table: string,
  field: string,
  value: string,
  cache: Map<string, string>,
  extra?: Record<string, unknown>,
): Promise<string | null> {
  if (!value || value.trim() === '') return null
  const key = value.trim()
  if (cache.has(key)) return cache.get(key)!

  const sb = getSupabase()
  const insertData = { [field]: key, ...extra }

  // Upsert: insert if new, silently ignore if a concurrent call already inserted it
  await sb.from(table).upsert(insertData, { onConflict: field, ignoreDuplicates: true })

  // Always re-select so we get the id regardless of whether we inserted or it already existed
  const { data: row, error } = await sb
    .from(table).select('id').eq(field, key).limit(1).single()

  if (error || !row) throw new Error(`Failed to resolve ${table} "${key}": ${error?.message}`)
  cache.set(key, row.id)
  return row.id
}

// ─── Resolve a project by name ───────────────────────────────

async function resolveProject(
  name: string,
  emEp: string | null,
  projectType: string | null,
  subTeam: string | null,
  cache: ForecastCache,
): Promise<string> {
  const normKey = normalizeProjectName(name)
  if (cache.projects.has(normKey)) return cache.projects.get(normKey)!

  const sb = getSupabase()

  // Try exact match first
  const { data: existing } = await sb
    .from('projects').select('id')
    .ilike('name', name.trim())
    .limit(1).single()

  if (existing) {
    cache.projects.set(normKey, existing.id)
    return existing.id
  }

  // Create new project
  const { data: created, error } = await sb
    .from('projects').insert({
      name: name.trim(),
      engagement_manager: emEp,
      project_type: mapProjectType(projectType),
      sub_team: subTeam,
    }).select('id').single()

  if (error) throw new Error(`Failed to create project "${name}": ${error.message}`)
  cache.projects.set(normKey, created!.id)
  return created!.id
}

// ─── Return types for bulk-write approach ────────────────────

interface ProcessedRow {
  empUuid: string
  allocationRows: Array<Record<string, unknown>>
  utilizationRow: Record<string, unknown> | null
}

// ─── Process a single forecast row (no DB writes for allocations) ────────────

async function processForecastRow(
  row: ForecastRow,
  cache: ForecastCache,
  sourceFile: string,
): Promise<ProcessedRow | ValidationError> {
  const sb = getSupabase()
  const emp = row.employee

  try {
    // 1. Resolve lookups (mostly cache hits after the first row)
    const desigId = await resolveOrCreate('designations', 'name', emp.grade ?? '', cache.designations)
    const locId = await resolveOrCreate('locations', 'name', emp.location ?? '', cache.locations)

    let deptId: string | null = null
    let subFuncId: string | null = null
    if (emp.subTeam) {
      const deptName = inferDepartment(emp.subTeam)
      deptId = await resolveOrCreate('departments', 'name', deptName, cache.departments)
      const sfCacheKey = `${deptId}|${emp.subTeam}`
      if (cache.subFunctions.has(sfCacheKey)) {
        subFuncId = cache.subFunctions.get(sfCacheKey)!
      } else {
        await sb.from('sub_functions')
          .upsert({ name: emp.subTeam, department_id: deptId }, { onConflict: 'department_id,name', ignoreDuplicates: true })
        const { data: sfRow } = await sb.from('sub_functions')
          .select('id').eq('name', emp.subTeam).eq('department_id', deptId).limit(1).single()
        if (sfRow) {
          subFuncId = sfRow.id
          cache.subFunctions.set(sfCacheKey, sfRow.id)
        }
      }
    }

    // 2. Upsert employee — must be done per-row to obtain UUID for allocation FK
    let empUuid: string

    if (cache.employees.has(emp.employeeId)) {
      empUuid = cache.employees.get(emp.employeeId)!
      await sb.from('employees').update({
        name: emp.name,
        email: emp.email,
        designation_id: desigId,
        department_id: deptId,
        sub_function_id: subFuncId,
        location_id: locId,
        work_mode: emp.workMode,
        ft_core: emp.ftCore,
        rocketlane_status: emp.rocketlane,
        date_of_joining: emp.doj,
        updated_at: new Date().toISOString(),
      }).eq('id', empUuid)
    } else {
      // Upsert handles concurrent parallel rows with the same employee_id
      // (which would cause a duplicate-key error on plain INSERT)
      const { data: upserted, error } = await sb.from('employees')
        .upsert({
          employee_id: emp.employeeId,
          name: emp.name,
          email: emp.email,
          designation_id: desigId,
          department_id: deptId,
          sub_function_id: subFuncId,
          location_id: locId,
          work_mode: emp.workMode,
          ft_core: emp.ftCore,
          rocketlane_status: emp.rocketlane,
          date_of_joining: emp.doj,
        }, { onConflict: 'employee_id' })
        .select('id').single()

      if (error) throw new Error(`Employee upsert failed: ${error.message}`)
      empUuid = upserted!.id
      cache.employees.set(emp.employeeId, empUuid)
    }

    // 3. Build allocation rows (NO delete/insert here — collected for bulk write later)
    const allocationRows: Array<Record<string, unknown>> = []

    for (const week of row.weeklyAllocations) {
      for (const alloc of week.allocations) {
        let projectId: string | null = null
        if (alloc.projectName) {
          projectId = await resolveProject(alloc.projectName, emp.currentEmEp, emp.projectType, emp.subTeam, cache)
        }
        allocationRows.push({
          employee_id: empUuid,
          project_id: projectId,
          week_start: week.weekStart,
          allocation_pct: alloc.allocationPct,
          allocation_status: alloc.status,
          raw_text: alloc.rawText || null,
          source_file: sourceFile,
        })
      }
    }

    // 4. Build utilization row (NO upsert here — collected for bulk write later)
    let utilizationRow: Record<string, unknown> | null = null
    if (emp.mtdUtilization != null || emp.ytdUtilization != null || emp.wtdUtilization != null) {
      utilizationRow = {
        employee_id: empUuid,
        snapshot_date: new Date().toISOString().split('T')[0],
        mtd_utilization: emp.mtdUtilization,
        wtd_utilization: emp.wtdUtilization,
        ytd_utilization: emp.ytdUtilization,
        comments: emp.comments,
        source_file: sourceFile,
      }
    }

    return { empUuid, allocationRows, utilizationRow }
  } catch (err) {
    return {
      row: row.rowIndex,
      field: 'processing',
      value: emp.employeeId,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Infer department from sub-team name ─────────────────────

function inferDepartment(subTeam: string): string {
  const upper = subTeam.toUpperCase()
  if (upper.startsWith('ARC')) return 'ARC'
  if (upper.startsWith('GRC')) return 'GRC'
  if (upper.startsWith('SCC')) return 'SCC'
  if (upper.startsWith('TECH') || upper.startsWith('TC')) return 'Tech Consulting'
  return 'Central'
}

// ─── Range Grouping ──────────────────────────────────────────
// Collapse per-week allocation rows (non-project statuses only) into
// contiguous date ranges suitable for the `allocations` table.
//
// Two weeks are "consecutive" when their week_start values are exactly
// 7 days apart AND carry the same allocation_status.  The resulting
// range uses the first week's Monday as start_date and the last week's
// Monday as end_date (matching the source column header semantics).

interface AllocationRange {
  employee_id: string
  type: string
  start_date: string        // first Monday of the run
  end_date: string          // last  Monday of the run
  allocation_percentage: number
}

function groupIntoRanges(rows: Array<Record<string, unknown>>): AllocationRange[] {
  // Only status rows (no project_id) belong in the allocations table
  const statusRows = rows.filter(r => r.project_id == null)
  if (statusRows.length === 0) return []

  // Group week_start strings by (employee_id, allocation_status)
  const byKey = new Map<string, string[]>()
  for (const row of statusRows) {
    const key = `${row.employee_id}|${row.allocation_status}`
    const arr = byKey.get(key) ?? []
    arr.push(row.week_start as string)
    byKey.set(key, arr)
  }

  const ranges: AllocationRange[] = []

  for (const [key, weeks] of byKey) {
    const [employee_id, type] = key.split('|')
    const sorted = [...new Set(weeks)].sort()   // dedupe + sort

    let rangeStart = sorted[0]
    let prev = sorted[0]

    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i]
      // Use T00:00:00 (local midnight) so DST boundaries don't break the
      // 7-day check. new Date("YYYY-MM-DD") parses as UTC which can cause
      // off-by-3600 s mismatches in DST-observing timezones.
      const consecutive =
        cur != null &&
        new Date(cur + 'T00:00:00').getTime() - new Date(prev + 'T00:00:00').getTime() === 7 * 86_400_000

      if (!consecutive) {
        ranges.push({ employee_id, type, start_date: rangeStart, end_date: prev, allocation_percentage: 100 })
        if (cur != null) rangeStart = cur
      }
      if (cur != null) prev = cur
    }
  }

  return ranges
}

// ─── Main Entry Point ────────────────────────────────────────

export async function ingestForecastFile(
  buffer: ArrayBuffer,
  fileName: string,
  uploadedBy?: string,
): Promise<ForecastIngestionResult> {
  const startTime = Date.now()
  const sb = getSupabase()

  // 1. Parse the Excel file
  const parsed = parseForecastExcel(buffer)

  if (parsed.rows.length === 0) {
    return {
      uploadId: '',
      fileType: 'forecast_tracker',
      totalRows: 0,
      successCount: 0,
      errorCount: parsed.errors.length || 1,
      errors: parsed.errors.length
        ? parsed.errors.map(e => ({ ...e, value: '' }))
        : [{ row: 0, field: '', value: '', message: 'No data rows found' }],
      weekRange: null,
      duration: Date.now() - startTime,
    }
  }

  // 2. Create upload log
  const { data: log } = await sb.from('upload_logs').insert({
    file_name: fileName,
    file_type: 'forecast_tracker',
    uploaded_by: uploadedBy || null,
    row_count: parsed.totalRows,
    status: 'processing',
  }).select('id').single()

  const uploadId = log?.id ?? ''

  // 3. Build caches (one parallel batch to pre-load all existing lookups)
  const cache = await buildForecastCache()

  // 4. Process rows in parallel batches — resolves lookups + upserts employees
  //    Does NOT write allocations yet; those are collected for a single bulk write
  const BATCH_SIZE = 50
  const allErrors: ValidationError[] = parsed.errors.map(e => ({ ...e, value: '' }))
  let successCount = 0

  const allAllocationRows: Array<Record<string, unknown>> = []
  const allUtilizationRows: Array<Record<string, unknown>> = []
  const allEmpUuids = new Set<string>()

  for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
    const batch = parsed.rows.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(row => processForecastRow(row, cache, fileName))
    )
    for (const result of results) {
      // ProcessedRow has empUuid; ValidationError has row/field/message
      if ('empUuid' in result) {
        successCount++
        allEmpUuids.add(result.empUuid)
        allAllocationRows.push(...result.allocationRows)
        if (result.utilizationRow) allUtilizationRows.push(result.utilizationRow)
      } else {
        allErrors.push(result)
      }
    }
  }

  // 5. Bulk delete existing allocations for all affected employees within the
  //    full week range of the sheet — not just weeks with data rows.
  //    This ensures that phantom allocations from a previous upload (which may
  //    have filled weeks beyond the actual data range) are cleaned up.
  if (allEmpUuids.size > 0 && parsed.weekColumns.length > 0) {
    const minWeek = parsed.weekColumns[0]
    const maxWeek = parsed.weekColumns[parsed.weekColumns.length - 1]
    await sb
      .from('forecast_allocations')
      .delete()
      .in('employee_id', [...allEmpUuids])
      .gte('week_start', minWeek)
      .lte('week_start', maxWeek)
  }

  // 5b. Deduplicate in-memory rows before inserting.
  //     The unique constraint is (employee_id, week_start, COALESCE(project_id, NULL_UUID)).
  //     If the same combo appears multiple times (e.g. employee has two rows in the sheet),
  //     keep the last occurrence so the most-specific/latest data wins.
  const seenAllocKeys = new Map<string, Record<string, unknown>>()
  for (const row of allAllocationRows) {
    const key = `${row.employee_id}|${row.week_start}|${row.project_id ?? '__null__'}`
    seenAllocKeys.set(key, row)  // overwrite earlier occurrence
  }
  const deduped = [...seenAllocKeys.values()]

  // 6. Bulk insert deduplicated rows in large chunks.
  //    The delete above cleared all existing rows for these employees+weeks,
  //    so a plain insert is safe — duplicates can only come from within the
  //    sheet itself, which the deduplication above handles.
  const ALLOC_CHUNK = 2000
  for (let i = 0; i < deduped.length; i += ALLOC_CHUNK) {
    const { error: allocErr } = await sb
      .from('forecast_allocations')
      .insert(deduped.slice(i, i + ALLOC_CHUNK))
    if (allocErr) throw new Error(`Bulk allocation insert failed: ${allocErr.message}`)
  }

  // 6c. Group non-project allocations into date ranges → upsert into `allocations`.
  //     This is the single source of truth for leave/available/jip/maternity ranges
  //     on the resource timeline (expanded back to weekly rows by the DB view).
  const allocationRanges = groupIntoRanges(allAllocationRows)
  if (allocationRanges.length > 0 && allEmpUuids.size > 0 && parsed.weekColumns.length > 0) {
    const minDate = parsed.weekColumns[0]
    const maxDate = parsed.weekColumns[parsed.weekColumns.length - 1]
    // Delete existing ranges for affected employees that overlap the sheet's span
    await sb
      .from('allocations')
      .delete()
      .in('employee_id', [...allEmpUuids])
      .lte('start_date', maxDate)
      .gte('end_date', minDate)

    // Upsert new ranges (idempotent on re-upload via unique index)
    const { error: allocRangeErr } = await sb
      .from('allocations')
      .upsert(
        allocationRanges.map(r => ({
          ...r,
          source_file: fileName,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'employee_id,type,start_date' },
      )
    if (allocRangeErr) throw new Error(`Allocation ranges upsert failed: ${allocRangeErr.message}`)
  }

  // 7. Bulk upsert all utilization snapshots in one call
  if (allUtilizationRows.length > 0) {
    const { error: utilErr } = await sb
      .from('utilization_snapshots')
      .upsert(allUtilizationRows, { onConflict: 'employee_id,snapshot_date' })
    if (utilErr) throw new Error(`Bulk utilization upsert failed: ${utilErr.message}`)
  }

  // 8. Finalize upload log
  const duration = Date.now() - startTime
  const weekRange = parsed.weekColumns.length > 0
    ? { start: parsed.weekColumns[0], end: parsed.weekColumns[parsed.weekColumns.length - 1] }
    : null

  if (uploadId) {
    await sb.from('upload_logs').update({
      success_count: successCount,
      error_count: allErrors.length,
      errors: allErrors.slice(0, 100),
      status: allErrors.length === parsed.totalRows ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', uploadId)
  }

  return {
    uploadId,
    fileType: 'forecast_tracker',
    totalRows: parsed.totalRows,
    successCount,
    errorCount: allErrors.length,
    errors: allErrors,
    weekRange,
    duration,
  }
}
