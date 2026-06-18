/**
 * GET /api/chargeability-performance
 * Returns per-employee timesheet records with available_hours and chargeable_hours
 * for a given period, used by the Chargeability Performance Dashboard.
 *
 * Query params:
 *   ?period=<period_month>  (e.g. "Mar-2026") — optional, defaults to latest
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'
import { normalizeSubFunction, isExcluded } from '../utils/sub-function-normalize'

const SHORT_MONTH_ORDER: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

function periodToSortKey(p: string): number {
  const parts = p.split('-')
  if (/^\d{4}$/.test(parts[0])) {
    return parseInt(parts[0]) * 12 + (parseInt(parts[1]) - 1)
  }
  const cap = parts[0].charAt(0).toUpperCase() + parts[0].slice(1, 3).toLowerCase()
  const mIdx = SHORT_MONTH_ORDER[cap] ?? 0
  return parseInt(parts[1]) * 12 + mIdx
}

function todayISO(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

export const chargeabilityPerformanceRouter = Router()

chargeabilityPerformanceRouter.get('/', asyncHandler(async (req, res) => {
  const sb = getSupabase()
  const requestedPeriod = typeof req.query.period === 'string' ? req.query.period : null

  // Step 1: Get distinct period_month values from v_compliance_overview
  // This view has ONE ROW PER PERIOD (aggregated), so it's the definitive period list.
  // Using raw timesheet_compliance sorted alphabetically would miss "Apr-*" because
  // 'A' < 'F' < 'M' and a row-limit could cut April off the end.
  const { data: periodsRaw } = await sb
    .from('v_compliance_overview')
    .select('period_month')

  const availablePeriods = [...new Set((periodsRaw ?? []).map((r: any) => r.period_month as string))]
    .sort((a, b) => periodToSortKey(b) - periodToSortKey(a))

  const currentPeriod = (requestedPeriod && availablePeriods.includes(requestedPeriod))
    ? requestedPeriod
    : availablePeriods[0] ?? null

  if (!currentPeriod) {
    return res.json({ period: null, availablePeriods: [], employees: [], weekRange: null })
  }

  // Step 2: Fetch timesheet_compliance for the selected period only
  // Join locations → regions to get the proper region name (not employee_region TEXT field)
  const { data: rawRows, error } = await sb
    .from('timesheet_compliance')
    .select(`
      period_month,
      available_hours,
      chargeable_hours,
      non_chargeable_hours,
      compliance_pct,
      chargeability_pct,
      employees!inner(
        id,
        employee_id,
        name,
        email,
        employee_region,
        employee_status,
        date_of_joining,
        departments(name),
        sub_functions(name),
        designations(name),
        locations(name, regions(name))
      )
    `)
    .eq('period_month', currentPeriod)
    .limit(5000)

  if (error) {
    return res.status(500).json({ error: error.message })
  }

  const rows = (rawRows ?? []).filter((r: any) =>
    !isExcluded(
      r.employees?.departments?.name,
      r.employees?.sub_functions?.name,
    )
  )

  // Step 3: Fetch ALL current-week forecast_allocations (not just one per employee)
  const weekStart = todayISO()
  const weekEnd   = addDays(weekStart, 6)

  const { data: allocRows } = await sb
    .from('forecast_allocations')
    .select(`
      employee_id,
      allocation_pct,
      allocation_status,
      week_start,
      projects(name, project_type)
    `)
    .gte('week_start', addDays(weekStart, -7))  // include previous week too
    .lte('week_start', addDays(weekStart, 7))
    .neq('allocation_status', 'available')
    .neq('allocation_status', 'Available')
    .order('allocation_pct', { ascending: false })
    .limit(5000)

  // Build map: internal employee UUID → array of current projects
  type ProjectEntry = { name: string; allocPct: number; status: string; projectType: string }
  const allocMap = new Map<string, ProjectEntry[]>()
  for (const a of (allocRows ?? []) as any[]) {
    const empId = a.employee_id as string
    if (!empId || !a.projects?.name) continue
    if (!allocMap.has(empId)) allocMap.set(empId, [])
    // Avoid duplicate project names
    const existing = allocMap.get(empId)!
    if (!existing.find(p => p.name === a.projects.name)) {
      existing.push({
        name: a.projects.name,
        allocPct: Number(a.allocation_pct) || 0,
        status: a.allocation_status ?? '',
        projectType: a.projects.project_type ?? '',
      })
    }
  }

  // Step 4: Map to flat employee records
  const employees = rows.map((r: any) => {
    const internalId = r.employees?.id ?? ''
    // Prefer joined region name (from locations → regions), fallback to employee_region text field
    const regionName = r.employees?.locations?.regions?.name ?? r.employees?.employee_region ?? ''
    return {
      empId: r.employees?.employee_id ?? '',
      internalId,
      name: r.employees?.name ?? '',
      email: r.employees?.email ?? '',
      department: r.employees?.departments?.name ?? '',
      subFunction: normalizeSubFunction(r.employees?.sub_functions?.name ?? ''),
      region: regionName,
      location: r.employees?.locations?.name ?? '',
      designation: r.employees?.designations?.name ?? '',
      employeeStatus: r.employees?.employee_status ?? '',
      dateOfJoining: r.employees?.date_of_joining ?? null,
      period: r.period_month ?? '',
      availableHours: Number(r.available_hours) || 0,
      chargeableHours: Number(r.chargeable_hours) || 0,
      nonChargeableHours: Number(r.non_chargeable_hours) || 0,
      chargeabilityPct: Number((Number(r.chargeability_pct) * 100).toFixed(1)),
      compliancePct: Number((Number(r.compliance_pct) * 100).toFixed(1)),
      currentProjects: allocMap.get(internalId) ?? [],
    }
  })

  return res.json({
    period: currentPeriod,
    availablePeriods,
    employees,
    weekRange: { start: weekStart, end: weekEnd },
  })
}))

/**
 * GET /api/chargeability-performance/trend
 * Returns chargeability trend (all periods) filtered by employee attributes.
 *
 * Query params (all optional, comma-separated for multi-value):
 *   depts, regions, locations, designations, subFuncs
 */
chargeabilityPerformanceRouter.get('/trend', asyncHandler(async (req, res) => {
  const sb = getSupabase()

  const parseList = (v: unknown): string[] =>
    typeof v === 'string' && v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : []

  const fDepts   = parseList(req.query.depts)
  const fRegions = parseList(req.query.regions)
  const fLocs    = parseList(req.query.locations)
  const fDesigs  = parseList(req.query.designations)
  const fSubs    = parseList(req.query.subFuncs)

  // Fetch all periods — no period_month filter, limit raised
  const { data: rawRows, error } = await sb
    .from('timesheet_compliance')
    .select(`
      period_month,
      chargeability_pct,
      available_hours,
      employees!inner(
        departments(name),
        sub_functions(name),
        designations(name),
        locations(name, regions(name))
      )
    `)
    .gt('available_hours', 0)
    .limit(50000)

  if (error) return res.status(500).json({ error: error.message })

  // Filter and aggregate
  type Acc = { totalPct: number; count: number }
  // key: `${period}::${department}`
  const agg = new Map<string, Acc>()
  const periods = new Set<string>()
  const depts = new Set<string>()

  for (const r of (rawRows ?? []) as any[]) {
    const emp = r.employees
    if (!emp) continue

    const dept   = emp.departments?.name ?? ''
    const sub    = normalizeSubFunction(emp.sub_functions?.name ?? '')
    const desig  = emp.designations?.name ?? ''
    const loc    = emp.locations?.name ?? ''
    const region = emp.locations?.regions?.name ?? ''
    const period = r.period_month ?? ''

    if (!dept || !period) continue
    if (isExcluded(dept, emp.sub_functions?.name)) continue

    if (fDepts.length   && !fDepts.includes(dept))     continue
    if (fSubs.length    && !fSubs.includes(sub))        continue
    if (fRegions.length && !fRegions.includes(region))  continue
    if (fLocs.length    && !fLocs.includes(loc))        continue
    if (fDesigs.length  && !fDesigs.includes(desig))    continue

    const key = `${period}::${dept}`
    if (!agg.has(key)) agg.set(key, { totalPct: 0, count: 0 })
    const entry = agg.get(key)!
    entry.totalPct += Number(r.chargeability_pct) * 100
    entry.count += 1
    periods.add(period)
    depts.add(dept)
  }

  const sortedPeriods = [...periods].sort((a, b) => periodToSortKey(a) - periodToSortKey(b))
  const sortedDepts   = [...depts].sort()

  const SHORT_MONTHS: Record<number, string> = {
    0: 'Jan', 1: 'Feb', 2: 'Mar', 3: 'Apr', 4: 'May', 5: 'Jun',
    6: 'Jul', 7: 'Aug', 8: 'Sep', 9: 'Oct', 10: 'Nov', 11: 'Dec',
  }
  function formatLabel(period: string): string {
    const parts = period.split('-')
    if (parts.length < 2) return period
    if (/^\d{4}$/.test(parts[0])) {
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1)
      return d.toLocaleString('default', { month: 'long', year: 'numeric' })
    }
    const cap = parts[0].charAt(0).toUpperCase() + parts[0].slice(1, 3).toLowerCase()
    return `${cap} ${parts[1]}`
  }

  const points = sortedPeriods.map(period => {
    const pt: Record<string, any> = { period, label: formatLabel(period) }
    let total = 0; let n = 0
    for (const dept of sortedDepts) {
      const entry = agg.get(`${period}::${dept}`)
      if (entry && entry.count > 0) {
        const v = +(entry.totalPct / entry.count).toFixed(1)
        pt[dept] = v
        total += v; n++
      } else {
        pt[dept] = null
      }
    }
    pt.overallPct = n > 0 ? +(total / n).toFixed(1) : null
    return pt
  })

  return res.json({ points, keys: sortedDepts })
}))
