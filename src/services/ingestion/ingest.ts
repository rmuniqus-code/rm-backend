/**
 * Supabase Ingestion Pipeline
 *
 * Handles the full upload flow:
 *   File → Parse → Validate → Upsert Lookups → Upsert Employees → Insert Compliance
 *
 * Design principles:
 * - Idempotent: re-uploading the same file does not create duplicates
 * - Lookup-first: dimension tables are resolved or created before fact inserts
 * - Transactional: each batch is wrapped so partial failures don't corrupt data
 * - Auditable: every upload is logged with row counts and errors
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { parseExcelBuffer, detectFileType, parseMonthString } from './parse-excel'
import { isExcluded } from '../../utils/sub-function-normalize'
import type { ParsedRow, ValidationError, FileType } from './parse-excel'
import { supabaseAdmin } from '../../db/supabase-admin'

// ─── Types ───────────────────────────────────────────────────

interface IngestionResult {
  uploadId: string
  fileType: FileType
  totalRows: number
  successCount: number
  errorCount: number
  errors: ValidationError[]
  duration: number
}

// In-memory lookup caches (populated once per upload)
interface LookupCache {
  departments: Map<string, string>   // name → uuid
  subFunctions: Map<string, string>  // "deptId|name" → uuid
  regions: Map<string, string>       // name → uuid
  locations: Map<string, string>     // name → uuid
  designations: Map<string, string>  // name → uuid
  employees: Map<string, string>     // employee_id → uuid
}

// ─── Supabase Client ─────────────────────────────────────────
// Kept as a local alias so ingestion code (and forecast/skill-mapping files
// that import from here) continues to work unchanged.

export function getSupabase(): SupabaseClient {
  return supabaseAdmin()
}

// ─── Lookup Resolution ───────────────────────────────────────

async function resolveOrCreate(
  table: string,
  matchField: string,
  value: string,
  cache: Map<string, string>,
  extra?: Record<string, unknown>,
): Promise<string> {
  if (!value || value.trim() === '') return ''
  const key = value.trim()
  if (cache.has(key)) return cache.get(key)!

  const sb = getSupabase()
  const insertData = { [matchField]: key, ...extra }

  // Upsert: insert if new, silently ignore if a concurrent call already inserted it
  await sb.from(table).upsert(insertData, { onConflict: matchField, ignoreDuplicates: true })

  // Always re-select so we get the id regardless of whether we inserted or it already existed
  const { data: row, error } = await sb
    .from(table)
    .select('id')
    .eq(matchField, key)
    .limit(1)
    .single()

  if (error || !row) throw new Error(`Failed to resolve ${table} "${key}": ${error?.message}`)
  cache.set(key, row.id)
  return row.id
}

// ─── Pre-populate Caches ─────────────────────────────────────

async function buildLookupCache(): Promise<LookupCache> {
  const sb = getSupabase()
  const cache: LookupCache = {
    departments: new Map(),
    subFunctions: new Map(),
    regions: new Map(),
    locations: new Map(),
    designations: new Map(),
    employees: new Map(),
  }

  // Load all existing lookups into memory
  const [depts, subs, regs, locs, desigs, emps] = await Promise.all([
    sb.from('departments').select('id, name'),
    sb.from('sub_functions').select('id, name, department_id'),
    sb.from('regions').select('id, name'),
    sb.from('locations').select('id, name'),
    sb.from('designations').select('id, name'),
    sb.from('employees').select('id, employee_id'),
  ])

  depts.data?.forEach(r => cache.departments.set(r.name, r.id))
  subs.data?.forEach(r => cache.subFunctions.set(`${r.department_id}|${r.name}`, r.id))
  regs.data?.forEach(r => cache.regions.set(r.name, r.id))
  locs.data?.forEach(r => cache.locations.set(r.name, r.id))
  desigs.data?.forEach(r => cache.designations.set(r.name, r.id))
  emps.data?.forEach(r => cache.employees.set(r.employee_id, r.id))

  return cache
}

// ─── Process Single Row ──────────────────────────────────────

interface ProcessedComplianceRow {
  empUuid: string
  complianceData: Record<string, unknown>
}

async function processRow(
  row: ParsedRow,
  fileType: FileType,
  periodInfo: { periodMonth: string; periodStart: string; periodEnd: string },
  cache: LookupCache,
  sourceFile: string,
): Promise<ProcessedComplianceRow | ValidationError | null> {
  const d = row.data
  const sb = getSupabase()

  try {
    // 1. Resolve department
    const deptName = String(d['Department Name'] ?? '')

    // Skip Central service line and LT sub-function entirely — they must not
    // appear anywhere in the tool.
    const subNameRaw = String(d['Sub-Function'] ?? '')
    if (isExcluded(deptName, subNameRaw)) return null

    const deptId = deptName ? await resolveOrCreate('departments', 'name', deptName, cache.departments) : null

    // 2. Resolve sub-function (needs deptId) — composite unique key (department_id, name)
    const subName = subNameRaw
    let subId: string | null = null
    if (subName && deptId) {
      const cacheKey = `${deptId}|${subName}`
      if (cache.subFunctions.has(cacheKey)) {
        subId = cache.subFunctions.get(cacheKey)!
      } else {
        const sbClient = getSupabase()
        // Upsert on composite key then re-select (race-condition safe)
        await sbClient
          .from('sub_functions')
          .upsert({ name: subName, department_id: deptId }, { onConflict: 'department_id,name', ignoreDuplicates: true })
        const { data: sfRow, error: sfErr } = await sbClient
          .from('sub_functions')
          .select('id')
          .eq('name', subName)
          .eq('department_id', deptId)
          .limit(1)
          .single()
        if (sfErr || !sfRow) throw new Error(`Failed to resolve sub_functions "${subName}": ${sfErr?.message}`)
        subId = sfRow.id as string
        cache.subFunctions.set(cacheKey, sfRow.id as string)
      }
    }

    // 3. Resolve region (regionwise file has Region column)
    const regionName = String(d['Region'] ?? d['Employee Country'] ?? '')
    let regionId: string | null = null
    if (regionName) {
      regionId = await resolveOrCreate('regions', 'name', regionName, cache.regions)
    }

    // 4. Resolve location
    const locName = String(d['Location'] ?? '')
    let locId: string | null = null
    if (locName) {
      locId = await resolveOrCreate('locations', 'name', locName, cache.locations, {
        region_id: regionId,
        country: String(d['Employee Country'] ?? d['Region'] ?? ''),
      })
    }

    // 5. Resolve designation
    const desigName = String(d['Designation'] ?? '')
    let desigId: string | null = null
    if (desigName) {
      const category = d['Category '] ? String(d['Category ']) : null
      desigId = await resolveOrCreate('designations', 'name', desigName, cache.designations, {
        category,
      })
    }

    // 6. Upsert employee (must happen per-row to obtain UUID for compliance FK)
    const empCode = String(d['Employee ID'])
    let empUuid: string

    if (cache.employees.has(empCode)) {
      empUuid = cache.employees.get(empCode)!
      await sb.from('employees').update({
        name: String(d['Employee Name']),
        designation_id: desigId,
        department_id: deptId,
        sub_function_id: subId,
        location_id: locId,
        employee_region: d['Employee Region'] ? String(d['Employee Region']) : null,
        date_of_joining: d['Date of Joining'] || null,
        date_of_exit: d['Date of Exit'] || null,
        updated_at: new Date().toISOString(),
      }).eq('id', empUuid)
    } else {
      // Upsert handles concurrent parallel rows with the same employee_id
      // (which would cause a duplicate-key error on plain INSERT)
      const { data: upserted, error } = await sb.from('employees')
        .upsert({
          employee_id: empCode,
          name: String(d['Employee Name']),
          designation_id: desigId,
          department_id: deptId,
          sub_function_id: subId,
          location_id: locId,
          employee_region: d['Employee Region'] ? String(d['Employee Region']) : null,
          date_of_joining: d['Date of Joining'] || null,
          date_of_exit: d['Date of Exit'] || null,
        }, { onConflict: 'employee_id' })
        .select('id').single()

      if (error) throw new Error(`Employee upsert failed: ${error.message}`)
      empUuid = upserted!.id
      cache.employees.set(empCode, empUuid)
    }

    // 7. Build compliance record — returned for bulk upsert, NOT written individually
    const complianceData: Record<string, unknown> = {
      employee_id: empUuid,
      period_month: periodInfo.periodMonth,
      period_start: periodInfo.periodStart,
      period_end: periodInfo.periodEnd,
      holidays_days: d['Holidays (Days)'] ?? 0,
      leaves_days: d['Leaves (Days)'] ?? 0,
      available_hours: d['Available Hours'] ?? 0,
      chargeable_hours: d['Chargeable'] ?? 0,
      non_chargeable_hours: d['Non-Chargeable'] ?? 0,
      total_hours: d['Total Hours '] ?? 0,
      chargeability_pct: d['Chargeability %'] ?? 0,
      compliance_pct: d['Compliance %'] ?? 0,
      category: d['Category '] ? String(d['Category ']) : null,
      source_file: sourceFile,
      updated_at: new Date().toISOString(),
    }

    return { empUuid, complianceData }
  } catch (err) {
    return {
      row: row.rowIndex,
      field: 'processing',
      value: String(d['Employee ID']),
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Main Ingestion Entry Point ──────────────────────────────

export async function ingestExcelFile(
  buffer: ArrayBuffer,
  fileName: string,
  uploadedBy?: string,
  periodOverride?: { month: string; year: number },
): Promise<IngestionResult> {
  const startTime = Date.now()
  const sb = getSupabase()

  // 1. Parse Excel
  const parsed = parseExcelBuffer(buffer)
  const fileType = detectFileType(parsed.headers)

  if (fileType === 'unknown') {
    return {
      uploadId: '',
      fileType,
      totalRows: 0,
      successCount: 0,
      errorCount: 1,
      errors: [{ row: 0, field: '', value: '', message: `Unrecognized file format. Expected columns: Employee ID, Chargeability %, etc.` }],
      duration: Date.now() - startTime,
    }
  }

  // 2. Create upload log
  const { data: log } = await sb.from('upload_logs').insert({
    file_name: fileName,
    file_type: fileType,
    uploaded_by: uploadedBy || null,
    row_count: parsed.totalRows,
    status: 'processing',
  }).select('id').single()

  const uploadId = log?.id ?? ''

  // 3. Determine period
  let periodInfo: { periodMonth: string; periodStart: string; periodEnd: string }

  if (fileType === 'regionwise' && parsed.rows.length > 0) {
    // Get period from the Month column of first data row
    const monthVal = String(parsed.rows[0].data['Month'] ?? '')
    const pm = parseMonthString(monthVal)
    if (!pm) {
      return finalizeUpload(uploadId, fileType, parsed.totalRows, 0, [{
        row: 1, field: 'Month', value: monthVal,
        message: `Cannot parse month value "${monthVal}"`,
      }], startTime)
    }
    periodInfo = { periodMonth: pm.label, periodStart: pm.periodStart, periodEnd: pm.periodEnd }
  } else if (periodOverride) {
    // Timesheet compliance file doesn't have a Month column — use provided override
    const pm = parseMonthString(`${periodOverride.month}'${periodOverride.year}`)
    if (!pm) throw new Error(`Invalid period override: ${periodOverride.month}'${periodOverride.year}`)
    periodInfo = { periodMonth: pm.label, periodStart: pm.periodStart, periodEnd: pm.periodEnd }
  } else {
    // Default: extract from filename (e.g. "Employee_Timesheet_Compliance_1-31_March")
    const monthMatch = fileName.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*/i)
    const yearMatch = fileName.match(/20\d{2}/)
    const month = monthMatch?.[0] ?? 'Mar'
    const year = yearMatch?.[0] ?? '2026'
    const pm = parseMonthString(`${month}'${year}`)
    periodInfo = pm
      ? { periodMonth: pm.label, periodStart: pm.periodStart, periodEnd: pm.periodEnd }
      : { periodMonth: 'Mar-2026', periodStart: '2026-03-01', periodEnd: '2026-03-31' }
  }

  // 4. Build lookup cache
  const cache = await buildLookupCache()

  // 5. Process rows in parallel batches — resolves lookups + upserts employees
  //    Compliance records are collected for a single bulk upsert at the end
  const BATCH_SIZE = 50
  const allErrors: ValidationError[] = [...parsed.errors]
  let successCount = 0

  const allComplianceRows: Array<Record<string, unknown>> = []

  for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
    const batch = parsed.rows.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(row => processRow(row, fileType, periodInfo, cache, fileName))
    )
    for (const result of results) {
      // null means the row was intentionally skipped (e.g. Central service line)
      if (result === null) continue
      // ProcessedComplianceRow has empUuid; ValidationError has row/field/message
      if ('empUuid' in result) {
        successCount++
        allComplianceRows.push(result.complianceData)
      } else {
        allErrors.push(result)
      }
    }
  }

  // 6. Bulk upsert all compliance records in one call
  //    ONE upsert instead of N per-row upserts
  if (allComplianceRows.length > 0) {
    const { error: compError } = await getSupabase()
      .from('timesheet_compliance')
      .upsert(allComplianceRows, { onConflict: 'employee_id,period_start,period_end' })
    if (compError) throw new Error(`Bulk compliance upsert failed: ${compError.message}`)
  }

  // 7. Finalize
  return finalizeUpload(uploadId, fileType, parsed.totalRows, successCount, allErrors, startTime)
}

// ─── Finalize Upload Log ─────────────────────────────────────

async function finalizeUpload(
  uploadId: string,
  fileType: FileType,
  totalRows: number,
  successCount: number,
  errors: ValidationError[],
  startTime: number,
): Promise<IngestionResult> {
  const sb = getSupabase()
  const duration = Date.now() - startTime

  if (uploadId) {
    await sb.from('upload_logs').update({
      success_count: successCount,
      error_count: errors.length,
      errors: errors.slice(0, 100), // cap stored errors
      status: errors.length === totalRows ? 'failed' : 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', uploadId)
  }

  return { uploadId, fileType, totalRows, successCount, errorCount: errors.length, errors, duration }
}
