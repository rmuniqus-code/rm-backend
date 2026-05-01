/**
 * GET /api/dashboard-data
 * Ported from app/api/dashboard-data/route.ts.
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'
import { normalizeSubFunction, isExcluded } from '../utils/sub-function-normalize'

function todayISO(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

function addWeeks(iso: string, weeks: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + weeks * 7)
  return d.toISOString().split('T')[0]
}

function jan1ISO(): string {
  return `${new Date().getUTCFullYear()}-01-01`
}

export const dashboardDataRouter = Router()

dashboardDataRouter.get('/', asyncHandler(async (req, res) => {
  const sb = getSupabase()

  // Optional ?month=YYYY-MM param to select a specific period
  const requestedMonth = typeof req.query.month === 'string' ? req.query.month : null

  // Compute 12-month look-back date for sub-team trend queries.
  // Format: YYYY-MM  (same as period_month column format).
  const now = new Date()
  const lookbackDate = new Date(now.getFullYear() - 1, now.getMonth())
  const oneYearAgoStr = `${lookbackDate.getFullYear()}-${String(lookbackDate.getMonth() + 1).padStart(2, '0')}`

  // Build the overview query: if a specific month is requested use it, otherwise use latest
  const overviewQuery = requestedMonth
    ? sb.from('v_compliance_overview').select('*').eq('period_month', requestedMonth).maybeSingle()
    : sb.from('v_compliance_overview').select('*').order('period_month', { ascending: false }).limit(1).maybeSingle()

  const [
    overviewRes,
    employeeCountRes,
    exitedCountRes,
    chargeRes,
    empRes,
    overAllocRes,
    projectsRes,
    availRes,
    zeroCompRes,
    tcSubTeamRes,
    tcYtdRes,
    empChargeRes,
    currentAllocRes,
    regionChargeRes,
  ] = await Promise.all([
    overviewQuery,
    sb.from('employees')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true),
    sb.from('employees')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', false),
    sb.from('v_chargeability_by_dept')
      .select('*')
      .order('period_month', { ascending: false }),
    sb.from('v_employee_details')
      .select('*')
      .eq('is_active', true)
      .order('name'),
    sb.rpc('fn_over_allocated', {
      p_from: todayISO(),
      p_to: addWeeks(todayISO(), 4),
    }),
    sb.from('v_project_summary').select('*'),
    sb.from('v_available_resources')
      .select('emp_code', { count: 'exact', head: true }),
    sb.from('timesheet_compliance')
      .select(`
        period_month,
        compliance_pct,
        total_hours,
        employees!inner(
          employee_id,
          name,
          designations(name),
          departments(name),
          locations(name),
          sub_functions(name)
        )
      `)
      .eq('compliance_pct', 0)
      .order('period_month', { ascending: false }),
    // Chargeability + compliance breakdown by (department, sub_function) for the last 12 months.
    // The date filter prevents hitting Supabase's default 1000-row row limit, ensuring
    // both current and previous periods are always present.
    sb.from('timesheet_compliance')
      .select(`
        period_month,
        chargeability_pct,
        compliance_pct,
        employees!inner(
          departments(name),
          sub_functions(name)
        )
      `)
      .gte('period_month', oneYearAgoStr)
      .order('period_month', { ascending: true }),
    // YTD chargeability — all periods starting from Jan 1 of current year
    sb.from('timesheet_compliance')
      .select('chargeability_pct, period_start')
      .gte('period_start', jan1ISO()),
    // Per-employee chargeability for current + YTD (all periods this year)
    sb.from('timesheet_compliance')
      .select(`
        period_month,
        chargeability_pct,
        compliance_pct,
        employees!inner(employee_id)
      `)
      .gte('period_month', `${new Date().getFullYear()}-01`)
      .order('period_month', { ascending: false }),
    // Current week's project per employee (most recent allocation)
    sb.from('forecast_allocations')
      .select(`
        employee_id,
        allocation_pct,
        allocation_status,
        projects(name),
        employees!inner(employee_id)
      `)
      .gte('week_start', addWeeks(todayISO(), -1))
      .lte('week_start', addWeeks(todayISO(), 1))
      .neq('allocation_status', 'Available')
      .order('allocation_pct', { ascending: false }),
    // Region-level chargeability + compliance (for region-filter KPI widgets)
    sb.from('v_chargeability_by_region')
      .select('region, period_month, headcount, avg_chargeability, avg_compliance')
      .order('period_month', { ascending: false }),
  ])

  const overview = overviewRes.data
  const totalEmployees = employeeCountRes.count ?? 0
  const exitedCount = exitedCountRes.count ?? 0
  // Filter out excluded departments (Central) and sub-functions (LT) from all raw data
  const chargeRows = (chargeRes.data ?? []).filter((r: any) => !isExcluded(r.department))
  const empRows = (empRes.data ?? []).filter((r: any) => !isExcluded(r.department, r.sub_function))
  const overAlloc = overAllocRes.data ?? []
  const projects = projectsRes.data ?? []
  const benchCount = availRes.count ?? 0

  // Derive available periods from chargeability data
  // Sort chronologically: convert "Mon-YYYY" → numeric key for correct ordering
  const SHORT_MONTH_ORDER: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  }
  function periodToSortKey(p: string): number {
    const parts = p.split('-')
    if (/^\d{4}$/.test(parts[0])) {
      // YYYY-MM
      return parseInt(parts[0]) * 12 + (parseInt(parts[1]) - 1)
    }
    const cap = parts[0].charAt(0).toUpperCase() + parts[0].slice(1, 3).toLowerCase()
    const mIdx = SHORT_MONTH_ORDER[cap] ?? 0
    return parseInt(parts[1]) * 12 + mIdx
  }
  const availablePeriods = [...new Set(chargeRows.map((r: any) => r.period_month as string))]
    .sort((a, b) => periodToSortKey(b) - periodToSortKey(a)) // descending: latest first
  // Use requested month if it exists in data, otherwise use the latest
  const currentPeriod = (requestedMonth && availablePeriods.includes(requestedMonth))
    ? requestedMonth
    : availablePeriods[0]
  const previousPeriodIdx = availablePeriods.indexOf(currentPeriod ?? '') + 1
  const previousPeriod = previousPeriodIdx < availablePeriods.length
    ? availablePeriods[previousPeriodIdx]
    : undefined

  const allZeroCompRows = (zeroCompRes.data ?? []).filter((r: any) =>
    !isExcluded(r.employees?.departments?.name, r.employees?.sub_functions?.name)
  )
  const zeroCompRows = currentPeriod
    ? allZeroCompRows.filter((r: any) => r.period_month === currentPeriod)
    : allZeroCompRows
  const timesheetGapCount = zeroCompRows.length
  const timesheetGaps = zeroCompRows.map((r: any) => ({
    name: r.employees?.name ?? '',
    empId: r.employees?.employee_id ?? '',
    department: r.employees?.departments?.name ?? '',
    subTeam: normalizeSubFunction(r.employees?.sub_functions?.name ?? ''),

    designation: r.employees?.designations?.name ?? '',
    location: r.employees?.locations?.name ?? '',
    compliancePct: 0,
    period: r.period_month ?? '',
    wc1: null,
    wc8: null,
  }))

  // Per-department + per-sub-team defaulter count
  type SubTeamCount = { subTeam: string; count: number }
  const gapDeptMap = new Map<string, { count: number; subTeams: Map<string, number> }>()
  for (const gap of timesheetGaps) {
    const dept = gap.department || 'Unknown'
    const sub = gap.subTeam || ''
    if (!gapDeptMap.has(dept)) gapDeptMap.set(dept, { count: 0, subTeams: new Map() })
    const entry = gapDeptMap.get(dept)!
    entry.count++
    if (sub) entry.subTeams.set(sub, (entry.subTeams.get(sub) ?? 0) + 1)
  }
  const timesheetGapsByTeam = [...gapDeptMap.entries()]
    .map(([department, v]) => ({
      department,
      count: v.count,
      subTeams: [...v.subTeams.entries()]
        .map(([subTeam, count]) => ({ subTeam, count } as SubTeamCount))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count)

  // YTD chargeability average
  const ytdRows = (tcYtdRes.data ?? []) as Array<{ chargeability_pct: number }>
  const utilizationYtd = ytdRows.length > 0
    ? Number(((ytdRows.reduce((s, r) => s + (Number(r.chargeability_pct) || 0), 0) / ytdRows.length) * 100).toFixed(1))
    : 0

  // Employment-status counts for the Active Resources card.
  // Serving Notice / Contract require a schema change and are returned as null placeholders for the UI.
  const activeResourcesCount = totalEmployees

  const kpi = {
    totalCapacity: totalEmployees,
    forecastedFte: (overview as any)?.total_employees ?? 0,
    utilization: overview ? Number(Number((overview as any).avg_chargeability).toFixed(1)) : 0,
    utilizationYtd,
    avgCompliance: overview ? Number(Number((overview as any).avg_compliance).toFixed(1)) : 0,
    benchCount,
    timesheetGapCount,
    overAllocated: new Set(overAlloc.map((r: any) => r.employee_id ?? r.emp_code)).size,
    variance: overview
      ? Number((Number((overview as any).avg_chargeability) - Number((overview as any).avg_compliance)).toFixed(1))
      : 0,
    activeResources: activeResourcesCount,
    servingNotice: null as number | null,   // pending schema addition
    contract: null as number | null,        // pending schema addition
    exited: exitedCount,
  }

  // Department-level chargeability / compliance (includes headcount from the view)
  type DeptAgg = { current: number; previous: number; headcount: number }
  const chargeByDept = new Map<string, DeptAgg>()
  const compByDept = new Map<string, DeptAgg>()
  for (const r of chargeRows as any[]) {
    const dept = r.department
    if (!chargeByDept.has(dept)) chargeByDept.set(dept, { current: 0, previous: 0, headcount: 0 })
    if (!compByDept.has(dept)) compByDept.set(dept, { current: 0, previous: 0, headcount: 0 })
    const cur = r.period_month === currentPeriod
    const prev = r.period_month === previousPeriod
    if (cur) {
      chargeByDept.get(dept)!.current = Number(Number(r.avg_chargeability).toFixed(1)) || 0
      chargeByDept.get(dept)!.headcount = Number(r.headcount) || 0
      compByDept.get(dept)!.current = Number(Number(r.avg_compliance).toFixed(1)) || 0
      compByDept.get(dept)!.headcount = Number(r.headcount) || 0
    }
    if (prev) {
      chargeByDept.get(dept)!.previous = Number(Number(r.avg_chargeability).toFixed(1)) || 0
      compByDept.get(dept)!.previous = Number(Number(r.avg_compliance).toFixed(1)) || 0
    }
  }
  const chargeability = [...chargeByDept.entries()].map(
    ([department, { current, previous, headcount }]) => ({ department, headcount, current, previous }),
  )
  const compliance = [...compByDept.entries()].map(
    ([department, { current, previous, headcount }]) => ({ department, headcount, current, previous }),
  )

  // Sub-team-level chargeability / compliance (department + sub_function)
  // Headcount is derived from empRows (active employees) so ALL sub-teams appear even when
  // they have no timesheet_compliance rows for the selected period.
  type SubAgg = {
    department: string
    subTeam: string
    headcount: number          // active employees — computed from empRows
    currentTotal: number
    currentN: number
    previousTotal: number
    previousN: number
    complianceCurrentTotal: number
    complianceCurrentN: number
    compliancePreviousTotal: number
    compliancePreviousN: number
    // All-periods trend: period_month → { chargeTotal, chargeN, compTotal, compN }
    trendMap: Map<string, { chargeTotal: number; chargeN: number; compTotal: number; compN: number }>
  }

  // Seed every (dept, sub_function) pair that has at least one active employee.
  const subMap = new Map<string, SubAgg>()
  for (const emp of empRows as any[]) {
    const dept = emp.department ?? ''
    const sub = normalizeSubFunction(emp.sub_function ?? '')
    if (!dept || !sub) continue
    const key = `${dept}|${sub}`
    if (!subMap.has(key)) {
      subMap.set(key, {
        department: dept,
        subTeam: sub,
        headcount: 0,
        currentTotal: 0, currentN: 0,
        previousTotal: 0, previousN: 0,
        complianceCurrentTotal: 0, complianceCurrentN: 0,
        compliancePreviousTotal: 0, compliancePreviousN: 0,
        trendMap: new Map(),
      })
    }
    subMap.get(key)!.headcount++
  }

  // Fill in chargeability/compliance averages from timesheet data
  for (const r of (tcSubTeamRes.data ?? []) as any[]) {
    const dept = r.employees?.departments?.name ?? 'Unknown'
    const sub = normalizeSubFunction(r.employees?.sub_functions?.name ?? '')
    if (!sub) continue
    if (isExcluded(dept, sub)) continue
    const key = `${dept}|${sub}`
    // Only process entries for sub-teams that exist among active employees
    const entry = subMap.get(key)
    if (!entry) continue
    const charge = Number(r.chargeability_pct) || 0
    const comp = Number(r.compliance_pct) || 0
    if (r.period_month === currentPeriod) {
      entry.currentTotal += charge; entry.currentN++
      entry.complianceCurrentTotal += comp; entry.complianceCurrentN++
    }
    if (r.period_month === previousPeriod) {
      entry.previousTotal += charge; entry.previousN++
      entry.compliancePreviousTotal += comp; entry.compliancePreviousN++
    }
    // Accumulate into trend map for all periods
    if (!entry.trendMap.has(r.period_month)) {
      entry.trendMap.set(r.period_month, { chargeTotal: 0, chargeN: 0, compTotal: 0, compN: 0 })
    }
    const te = entry.trendMap.get(r.period_month)!
    te.chargeTotal += charge; te.chargeN++
    te.compTotal += comp; te.compN++
  }
  const toPct = (total: number, n: number) => n > 0 ? Number(((total / n) * 100).toFixed(1)) : 0
  const chargeabilityBySubTeam = [...subMap.values()].map(e => ({
    department: e.department,
    subTeam: e.subTeam,
    headcount: e.headcount,
    current: toPct(e.currentTotal, e.currentN),
    previous: toPct(e.previousTotal, e.previousN),
  })).sort((a, b) => a.department.localeCompare(b.department) || a.subTeam.localeCompare(b.subTeam))
  const complianceBySubTeam = [...subMap.values()].map(e => ({
    department: e.department,
    subTeam: e.subTeam,
    headcount: e.headcount,
    current: toPct(e.complianceCurrentTotal, e.complianceCurrentN),
    previous: toPct(e.compliancePreviousTotal, e.compliancePreviousN),
  })).sort((a, b) => a.department.localeCompare(b.department) || a.subTeam.localeCompare(b.subTeam))

  // Yearly trend: per (dept, sub-team) and per dept, all months in look-back window
  const chargeabilityTrendBySubTeam = [...subMap.values()].map(e => ({
    department: e.department,
    subTeam: e.subTeam,
    trend: [...e.trendMap.entries()]
      .sort(([a], [b]) => periodToSortKey(a) - periodToSortKey(b))
      .map(([period, { chargeTotal, chargeN }]) => ({
        period,
        value: chargeN > 0 ? Number(((chargeTotal / chargeN) * 100).toFixed(1)) : 0,
      })),
  }))
  const complianceTrendBySubTeam = [...subMap.values()].map(e => ({
    department: e.department,
    subTeam: e.subTeam,
    trend: [...e.trendMap.entries()]
      .sort(([a], [b]) => periodToSortKey(a) - periodToSortKey(b))
      .map(([period, { compTotal, compN }]) => ({
        period,
        value: compN > 0 ? Number(((compTotal / compN) * 100).toFixed(1)) : 0,
      })),
  }))

  // Dept-level trend built from chargeRows (v_chargeability_by_dept — already has all periods)
  const deptChargeTrendMap = new Map<string, Map<string, { total: number; hc: number }>>()
  const deptCompTrendMap = new Map<string, Map<string, { total: number; hc: number }>>()
  for (const r of chargeRows as any[]) {
    const dept = r.department; const period = r.period_month
    if (!dept || !period) continue
    const hc = Number(r.headcount) || 1
    if (!deptChargeTrendMap.has(dept)) deptChargeTrendMap.set(dept, new Map())
    if (!deptCompTrendMap.has(dept)) deptCompTrendMap.set(dept, new Map())
    const cp = deptChargeTrendMap.get(dept)!
    const xp = deptCompTrendMap.get(dept)!
    if (!cp.has(period)) cp.set(period, { total: 0, hc: 0 })
    if (!xp.has(period)) xp.set(period, { total: 0, hc: 0 })
    cp.get(period)!.total += (Number(r.avg_chargeability) || 0) * hc
    cp.get(period)!.hc += hc
    xp.get(period)!.total += (Number(r.avg_compliance) || 0) * hc
    xp.get(period)!.hc += hc
  }
  const chargeabilityTrendByDept = [...deptChargeTrendMap.entries()].map(([department, pMap]) => ({
    department,
    trend: [...pMap.entries()]
      .sort(([a], [b]) => periodToSortKey(a) - periodToSortKey(b))
      .map(([period, { total, hc }]) => ({ period, value: hc > 0 ? Number((total / hc).toFixed(1)) : 0 })),
  }))
  const complianceTrendByDept = [...deptCompTrendMap.entries()].map(([department, pMap]) => ({
    department,
    trend: [...pMap.entries()]
      .sort(([a], [b]) => periodToSortKey(a) - periodToSortKey(b))
      .map(([period, { total, hc }]) => ({ period, value: hc > 0 ? Number((total / hc).toFixed(1)) : 0 })),
  }))

  // Per-employee chargeability/compliance: MTD (current period) + YTD (avg this year)
  // chargeability_pct in timesheet_compliance is stored as fraction (0–1).
  // Multiply by 100 to get percentage for display.
  const empChargeMap = new Map<string, {
    mtd: number | null
    complianceMtd: number | null
    ytdTotal: number
    ytdCount: number
  }>()
  for (const r of (empChargeRes.data ?? []) as any[]) {
    const empCode = r.employees?.employee_id ?? ''
    if (!empCode) continue
    if (!empChargeMap.has(empCode)) {
      empChargeMap.set(empCode, { mtd: null, complianceMtd: null, ytdTotal: 0, ytdCount: 0 })
    }
    const entry = empChargeMap.get(empCode)!
    const pct = Number(r.chargeability_pct ?? 0) * 100
    const compPct = Number(r.compliance_pct ?? 0) * 100
    if (r.period_month === currentPeriod && entry.mtd === null) {
      entry.mtd = Number(pct.toFixed(1))
    }
    if (r.period_month === currentPeriod && entry.complianceMtd === null) {
      entry.complianceMtd = Number(compPct.toFixed(1))
    }
    entry.ytdTotal += pct
    entry.ytdCount++
  }

  // Current-week project per employee: pick highest-pct non-available allocation
  const currentProjectMap = new Map<string, string>()
  const jipEmployees = new Set<string>()
  for (const r of (currentAllocRes.data ?? []) as any[]) {
    const empCode = r.employees?.employee_id ?? ''
    if (!empCode) continue
    const status = (r.allocation_status ?? '').toLowerCase()
    if (status === 'jip') jipEmployees.add(empCode)
    if (!currentProjectMap.has(empCode)) {
      const projectName = r.projects?.name ?? r.allocation_status ?? ''
      if (projectName) currentProjectMap.set(empCode, projectName)
    }
  }

  const employees = empRows.map((e: any) => {
    const empCode = e.emp_code ?? ''
    const chargeEntry = empChargeMap.get(empCode)
    const isJip = jipEmployees.has(empCode)
    return {
      department: e.department ?? '',
      subFunction: normalizeSubFunction(e.sub_function ?? ''),
      empId: empCode,
      name: e.name ?? '',
      email: e.email ?? '',
      designation: e.designation ?? '',
      location: e.location ?? '',
      region: e.region ?? '',
      dateOfJoining: e.date_of_joining ?? '',
      status: e.is_active ? 'green' : 'red',
      // JIP employees are not on billable work — show 0% utilization
      chargeabilityMTD: isJip ? 0 : (chargeEntry?.mtd ?? null),
      complianceMTD: chargeEntry?.complianceMtd ?? null,
      chargeabilityYTD: chargeEntry && chargeEntry.ytdCount > 0
        ? Number((chargeEntry.ytdTotal / chargeEntry.ytdCount).toFixed(1))
        : null,
      currentProject: currentProjectMap.get(empCode) ?? null,
    }
  })

  const locMap = new Map<string, any>()
  for (const emp of empRows as any[]) {
    const loc = emp.location ?? 'Unknown'
    if (!locMap.has(loc)) {
      locMap.set(loc, {
        location: loc, region: emp.region ?? '',
        analyst: null, assocConsultant: null, consultant: null,
        asstManager: null, manager: null, assocDirector: null, total: 0,
      })
    }
    const row = locMap.get(loc)!
    const desg = (emp.designation ?? '').toLowerCase()
    row.total++
    if (desg.includes('analyst')) row.analyst = (row.analyst ?? 0) + 1
    else if (desg.includes('associate consultant')) row.assocConsultant = (row.assocConsultant ?? 0) + 1
    else if (desg.includes('consultant')) row.consultant = (row.consultant ?? 0) + 1
    else if (desg.includes('assistant manager')) row.asstManager = (row.asstManager ?? 0) + 1
    else if (desg.includes('manager')) row.manager = (row.manager ?? 0) + 1
    else if (desg.includes('director')) row.assocDirector = (row.assocDirector ?? 0) + 1
  }
  const allocation = [...locMap.values()].sort((a: any, b: any) => a.location.localeCompare(b.location))

  const deptCap = new Map<string, number>()
  for (const emp of empRows as any[]) deptCap.set(emp.department ?? 'Other', (deptCap.get(emp.department ?? 'Other') ?? 0) + 1)
  const capacityByServiceLine = [...deptCap.entries()].map(([serviceLine, capacity]) => ({
    serviceLine, capacity, forecast: capacity, actual: capacity, subServiceLines: [] as string[],
  }))

  const locCap = new Map<string, number>()
  for (const emp of empRows as any[]) locCap.set(emp.location ?? 'Other', (locCap.get(emp.location ?? 'Other') ?? 0) + 1)
  const capacityByLocation = [...locCap.entries()].map(([location, capacity]) => ({
    location, capacity, forecast: capacity, actual: capacity,
  }))

  const periodUtil = new Map<string, { total: number; count: number }>()
  for (const r of chargeRows as any[]) {
    const p = r.period_month
    if (!periodUtil.has(p)) periodUtil.set(p, { total: 0, count: 0 })
    const e = periodUtil.get(p)!
    e.total += Number(r.avg_chargeability) || 0
    e.count++
  }
  const utilizationTrend = [...periodUtil.entries()]
    .sort(([a], [b]) => (a as string).localeCompare(b as string))
    .map(([week, { total, count }]) => {
      const avg = count > 0 ? Math.round(total / count) : 0
      return { week, forecast: avg, actual: avg }
    })

  const overAllocList = overAlloc.map((r: any) => ({
    id: r.employee_id ?? r.emp_code,
    empCode: r.emp_code,
    name: r.employee_name,
    weekStart: r.week_start,
    totalAllocation: r.total_allocation,
    projectCount: r.project_count,
  }))

  const projectList = projects.map((p: any) => ({
    id: p.project_id,
    name: p.project_name,
    client: p.client ?? '',
    projectType: p.project_type ?? '',
    status: p.status ?? 'active',
    teamSize: p.team_member_count ?? 0,
    firstWeek: p.first_week,
    lastWeek: p.last_week,
  }))

  // Region-level chargeability / compliance — headcount-weighted average across categories
  type RegionAgg = { current: number; currentHC: number; previous: number; previousHC: number }
  const chargeByRegion = new Map<string, RegionAgg>()
  const compByRegion = new Map<string, RegionAgg>()
  for (const r of (regionChargeRes.data ?? []) as any[]) {
    const region = r.region ?? ''
    if (!region) continue
    if (!chargeByRegion.has(region)) chargeByRegion.set(region, { current: 0, currentHC: 0, previous: 0, previousHC: 0 })
    if (!compByRegion.has(region)) compByRegion.set(region, { current: 0, currentHC: 0, previous: 0, previousHC: 0 })
    const hc = Number(r.headcount) || 0
    if (r.period_month === currentPeriod) {
      chargeByRegion.get(region)!.current += (Number(r.avg_chargeability) || 0) * hc
      chargeByRegion.get(region)!.currentHC += hc
      compByRegion.get(region)!.current += (Number(r.avg_compliance) || 0) * hc
      compByRegion.get(region)!.currentHC += hc
    }
    if (r.period_month === previousPeriod) {
      chargeByRegion.get(region)!.previous += (Number(r.avg_chargeability) || 0) * hc
      chargeByRegion.get(region)!.previousHC += hc
      compByRegion.get(region)!.previous += (Number(r.avg_compliance) || 0) * hc
      compByRegion.get(region)!.previousHC += hc
    }
  }
  const chargeabilityByRegion = [...chargeByRegion.entries()].map(([region, v]) => ({
    region,
    current: v.currentHC > 0 ? Number((v.current / v.currentHC).toFixed(1)) : 0,
    headcount: v.currentHC,
  }))
  const complianceByRegion = [...compByRegion.entries()].map(([region, v]) => ({
    region,
    current: v.currentHC > 0 ? Number((v.current / v.currentHC).toFixed(1)) : 0,
    headcount: v.currentHC,
  }))

  res.json({
    kpi,
    chargeability,
    chargeabilityBySubTeam,
    compliance,
    complianceBySubTeam,
    employees,
    allocation,
    capacityByServiceLine,
    capacityByLocation,
    utilizationTrend,
    overAllocList,
    projectList,
    timesheetGaps,
    timesheetGapsByTeam,
    availablePeriods,
    currentPeriod: currentPeriod ?? null,
    chargeabilityByRegion,
    complianceByRegion,
    chargeabilityTrendByDept,
    chargeabilityTrendBySubTeam,
    complianceTrendByDept,
    complianceTrendBySubTeam,
  })
}))
