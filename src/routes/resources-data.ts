/**
 * GET /api/resources-data
 * Ported from app/api/resources-data/route.ts.
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'

const SELECT_COLS =
  'emp_code,employee_name,designation,department,sub_function,location,' +
  'week_start,allocation_pct,allocation_status,project_name,project_client,project_type'

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
  const fromISO = (req.query.from as string) ?? addWeeks(mondayOf(today), -8)
  const toISO = (req.query.to as string) ?? addWeeks(mondayOf(today), 20)

  const sb = getSupabase()

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
      .select('emp_code,region,department')
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

  const empRegionMap: Record<string, { region: string; department: string }> = {}
  for (const row of empMetaRows ?? []) {
    if (row.emp_code) {
      empRegionMap[row.emp_code] = {
        region: row.region ?? '',
        department: row.department ?? '',
      }
    }
  }

  res.json({ rows: allRows, skills: skillsMap, empMeta: empRegionMap, fromISO, toISO })
}))
