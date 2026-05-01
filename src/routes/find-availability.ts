/**
 * GET /api/find-availability
 * Ported from app/api/find-availability/route.ts (Next.js → Express).
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'
import { normalizeSubFunction, isExcluded } from '../utils/sub-function-normalize'

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

function addWeeks(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n * 7)
  return toLocalISO(d)
}

const ALLOC_PAGE = 1000
const BOOKED_STATUSES = ['confirmed', 'proposed', 'unconfirmed']

export const findAvailabilityRouter = Router()

findAvailabilityRouter.get('/', asyncHandler(async (req, res) => {
  const today = new Date()
  const fromISO = (req.query.startDate as string) ?? mondayOf(today)
  const toISO = (req.query.endDate as string) ?? addWeeks(mondayOf(today), 4)
  const gradeFilter = (req.query.grade as string) ?? ''
  const serviceLineFilter = (req.query.serviceLine as string) ?? ''

  const sb = getSupabase()

  let empQuery = sb
    .from('v_employee_details')
    .select('emp_code,name,designation,department,sub_function,location,region')
    .eq('is_active', true)
    .order('name')

  if (gradeFilter) empQuery = empQuery.eq('designation', gradeFilter)
  if (serviceLineFilter) empQuery = empQuery.eq('department', serviceLineFilter)

  const { data: empRows, error: empError } = await empQuery
  if (empError) return res.status(500).json({ error: empError.message })

  const employees: any[] = empRows ?? []

  const { data: skillRows } = await sb
    .from('v_employee_skills')
    .select('emp_code,primary_skill')

  const skillMap = new Map<string, string>()
  for (const s of skillRows ?? []) {
    if (s.emp_code && s.primary_skill) skillMap.set(s.emp_code, s.primary_skill)
  }

  const allocRows: any[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await sb
      .from('v_resource_allocation_grid')
      .select('emp_code,allocation_pct,week_start,allocation_status')
      .gte('week_start', fromISO)
      .lte('week_start', toISO)
      .in('allocation_status', BOOKED_STATUSES)
      .range(offset, offset + ALLOC_PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    allocRows.push(...data)
    if (data.length < ALLOC_PAGE) break
    offset += ALLOC_PAGE
  }

  const weekTotals = new Map<string, Map<string, number>>()
  for (const row of allocRows) {
    if (!weekTotals.has(row.emp_code)) weekTotals.set(row.emp_code, new Map())
    const wMap = weekTotals.get(row.emp_code)!
    wMap.set(row.week_start, (wMap.get(row.week_start) ?? 0) + (row.allocation_pct ?? 0))
  }

  const avgPct = new Map<string, number>()
  for (const [empCode, wMap] of weekTotals.entries()) {
    const total = Array.from(wMap.values()).reduce((a, b) => a + b, 0)
    avgPct.set(empCode, total / wMap.size)
  }

  const resources = employees
    .filter((e: any) => !isExcluded(e.department, e.sub_function))
    .map((e: any) => ({
      id: e.emp_code,
      name: e.name,
      grade: e.designation ?? '',
      serviceLine: e.department ?? '',
      subServiceLine: normalizeSubFunction(e.sub_function ?? ''),
      location: e.location ?? '',
      region: e.region ?? '',
      primarySkill: skillMap.get(e.emp_code) ?? '',
      totalFte: Math.round((avgPct.get(e.emp_code) ?? 0)) / 100,
    }))
    .filter(r => r.totalFte < 1.0)
    .sort((a, b) => a.totalFte - b.totalFte)

  res.json({ resources, fromISO, toISO })
}))
