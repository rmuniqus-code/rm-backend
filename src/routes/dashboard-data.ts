/**
 * GET /api/dashboard-data
 * Ported from app/api/dashboard-data/route.ts.
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'

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

export const dashboardDataRouter = Router()

dashboardDataRouter.get('/', asyncHandler(async (_req, res) => {
  const sb = getSupabase()

  const [
    overviewRes,
    employeeCountRes,
    chargeRes,
    empRes,
    overAllocRes,
    projectsRes,
    availRes,
    zeroCompRes,
  ] = await Promise.all([
    sb.from('v_compliance_overview')
      .select('*')
      .order('period_month', { ascending: false })
      .limit(1)
      .single(),
    sb.from('employees')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true),
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
          departments(name)
        )
      `)
      .eq('compliance_pct', 0)
      .order('period_month', { ascending: false }),
  ])

  const overview = overviewRes.data
  const totalEmployees = employeeCountRes.count ?? 0
  const chargeRows = chargeRes.data ?? []
  const empRows = empRes.data ?? []
  const overAlloc = overAllocRes.data ?? []
  const projects = projectsRes.data ?? []
  const benchCount = availRes.count ?? 0

  const allZeroCompRows = zeroCompRes.data ?? []
  const latestPeriod = (overview as any)?.period_month
  const zeroCompRows = latestPeriod
    ? allZeroCompRows.filter((r: any) => r.period_month === latestPeriod)
    : allZeroCompRows
  const timesheetGapCount = zeroCompRows.length
  const timesheetGaps = zeroCompRows.map((r: any) => ({
    name: r.employees?.name ?? '',
    empId: r.employees?.employee_id ?? '',
    department: r.employees?.departments?.name ?? '',
    designation: r.employees?.designations?.name ?? '',
    compliancePct: 0,
    period: r.period_month ?? '',
    wc1: null,
    wc8: null,
  }))

  const kpi = {
    totalCapacity: totalEmployees,
    forecastedFte: (overview as any)?.total_employees ?? 0,
    utilization: overview ? Number(Number((overview as any).avg_chargeability).toFixed(1)) : 0,
    avgCompliance: overview ? Number(Number((overview as any).avg_compliance).toFixed(1)) : 0,
    benchCount,
    timesheetGapCount,
    overAllocated: new Set(overAlloc.map((r: any) => r.employee_id ?? r.emp_code)).size,
    variance: overview
      ? Number((Number((overview as any).avg_chargeability) - Number((overview as any).avg_compliance)).toFixed(1))
      : 0,
  }

  const periods = [...new Set(chargeRows.map((r: any) => r.period_month))].sort().reverse()
  const currentPeriod = periods[0]
  const previousPeriod = periods[1]

  const chargeByDept = new Map<string, { current: number; previous: number }>()
  const compByDept = new Map<string, { current: number; previous: number }>()
  for (const r of chargeRows as any[]) {
    const dept = r.department
    if (!chargeByDept.has(dept)) chargeByDept.set(dept, { current: 0, previous: 0 })
    if (!compByDept.has(dept)) compByDept.set(dept, { current: 0, previous: 0 })
    if (r.period_month === currentPeriod) {
      chargeByDept.get(dept)!.current = Number(Number(r.avg_chargeability).toFixed(1)) || 0
      compByDept.get(dept)!.current = Number(Number(r.avg_compliance).toFixed(1)) || 0
    }
    if (r.period_month === previousPeriod) {
      chargeByDept.get(dept)!.previous = Number(Number(r.avg_chargeability).toFixed(1)) || 0
      compByDept.get(dept)!.previous = Number(Number(r.avg_compliance).toFixed(1)) || 0
    }
  }
  const chargeability = [...chargeByDept.entries()].map(
    ([department, { current, previous }]) => ({ department, current, previous }),
  )
  const compliance = [...compByDept.entries()].map(
    ([department, { current, previous }]) => ({ department, current, previous }),
  )

  const employees = empRows.map((e: any) => ({
    department: e.department ?? '',
    subFunction: e.sub_function ?? '',
    empId: e.emp_code ?? '',
    name: e.name ?? '',
    email: e.email ?? '',
    designation: e.designation ?? '',
    location: e.location ?? '',
    region: e.region ?? '',
    dateOfJoining: e.date_of_joining ?? '',
    status: e.is_active ? 'green' : 'red',
  }))

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

  res.json({
    kpi, chargeability, compliance, employees, allocation,
    capacityByServiceLine, capacityByLocation, utilizationTrend,
    overAllocList, projectList, timesheetGaps,
  })
}))
