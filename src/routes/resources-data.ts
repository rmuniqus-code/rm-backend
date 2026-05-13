/**
 * GET /api/resources-data
 * Ported from app/api/resources-data/route.ts.
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'
import { normalizeSubFunction, isExcluded } from '../utils/sub-function-normalize'

const SELECT_COLS =
  'emp_code,employee_name,designation,department,sub_function,location,' +
  'week_start,allocation_pct,allocation_status,project_name,project_client,project_type,engagement_manager,current_em_ep,raw_text'

const PAGE_SIZE = 1000

function toLocalISO(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

function mondayOf(d: Date): string {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const m = new Date(d)
  m.setDate(d.getDate() + diff)
  m.setHours(0, 0, 0, 0)
  return toLocalISO(m)
}

function addWeeks(iso: string, weeks: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + weeks * 7)
  return toLocalISO(d)
}

export const resourcesDataRouter = Router()

resourcesDataRouter.get('/', asyncHandler(async (req, res) => {
  const today = new Date()
  const sb = getSupabase()

  // Derive the default date range from the actual data in forecast_allocations so
  // that ALL uploaded forecast data is visible, regardless of how far back or
  // forward it extends.  A narrow fixed-offset window (e.g. -8 to +20 weeks)
  // silently excludes historical allocations that were ingested but lie outside
  // the window — the resource view would fetch nothing for those weeks.
  let defaultFrom = addWeeks(mondayOf(today), -8)
  let defaultTo   = addWeeks(mondayOf(today), 20)
  if (!req.query.from || !req.query.to) {
    const [{ data: minRow }, { data: maxRow }] = await Promise.all([
      sb.from('forecast_allocations').select('week_start').order('week_start', { ascending: true  }).limit(1),
      sb.from('forecast_allocations').select('week_start').order('week_start', { ascending: false }).limit(1),
    ])
    if (minRow?.[0]?.week_start) defaultFrom = minRow[0].week_start
    if (maxRow?.[0]?.week_start) defaultTo   = maxRow[0].week_start
  }

  const fromISO = (req.query.from as string) ?? defaultFrom
  const toISO   = (req.query.to   as string) ?? defaultTo

  const { count, error: countError } = await sb
    .from('v_resource_allocation_grid')
    .select('*', { count: 'exact', head: true })
    .gte('week_start', fromISO)
    .lte('week_start', toISO)

  if (countError) return res.status(500).json({ error: countError.message })

  const totalRows = count ?? 0
  res.set('Cache-Control', 'public, s-maxage=180, stale-while-revalidate=300')

  if (totalRows === 0) {
    return res.json({ rows: [], fromISO, toISO })
  }

  const pageCount = Math.ceil(totalRows / PAGE_SIZE)

  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      sb
        .from('v_resource_allocation_grid')
        .select(SELECT_COLS)
        .gte('week_start', fromISO)
        .lte('week_start', toISO)
        .order('week_start', { ascending: true })
        .range(i * PAGE_SIZE, (i + 1) * PAGE_SIZE - 1),
    ),
  )

  const firstError = pages.find(p => p.error)
  if (firstError?.error) {
    return res.status(500).json({ error: firstError.error.message })
  }

  const allRows = pages.flatMap(p => p.data ?? [])

  const [{ data: skillRows }, { data: empMetaRows }] = await Promise.all([
    sb.from('v_employee_skills').select('emp_code,primary_skill,secondary_skills'),
    sb.from('v_employee_details')
      .select('emp_code,region,department,sub_function,employee_status')
      .eq('is_active', true),
  ])

  const skillsMap: Record<string, { primary: string; secondary: string[] }> = {}
  for (const s of skillRows ?? []) {
    if (s.emp_code) {
      skillsMap[s.emp_code] = {
        primary: s.primary_skill ?? '',
        secondary: Array.isArray(s.secondary_skills) ? s.secondary_skills.filter(Boolean) : [],
      }
    }
  }

  const empRegionMap: Record<string, { region: string; department: string; subFunction: string; employeeStatus: string }> = {}
  for (const row of empMetaRows ?? []) {
    if (row.emp_code && !isExcluded(row.department, row.sub_function)) {
      empRegionMap[row.emp_code] = {
        region: row.region ?? '',
        department: row.department ?? '',
        subFunction: normalizeSubFunction(row.sub_function ?? ''),
        employeeStatus: row.employee_status ?? '',
      }
    }
  }

  // Normalize sub_function in every row and exclude Central / LT rows.
  const normalizedRows = allRows
    .filter((r: any) => !isExcluded(r.department, r.sub_function))
    .map((r: any) => ({
    ...r,
    sub_function: normalizeSubFunction(r.sub_function),
  }))

  res.json({ rows: normalizedRows, skills: skillsMap, empMeta: empRegionMap, fromISO, toISO })
}))
