/**
 * GET /api/outliers — ported from app/api/outliers/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseISODate } from '../middleware/error'

interface OutlierEntry {
  employee_id: string
  employee_code: string
  employee_name: string
  designation: string
  department: string
  location: string
  outlier_type: string
  metric_value: number
  threshold: number
  detail: string
  week_start: string | null
  region?: string
  serviceLine?: string
  projects?: { name: string; allocation_pct: number; status: string }[]
}

function todayMonday(): string {
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

function groupBy(outliers: OutlierEntry[], field: keyof OutlierEntry) {
  const map = new Map<string, { count: number; missed_timesheet: number; low_utilization: number; over_allocated: number }>()
  for (const o of outliers) {
    const key = String(o[field] ?? 'Unknown')
    if (!map.has(key)) map.set(key, { count: 0, missed_timesheet: 0, low_utilization: 0, over_allocated: 0 })
    const g = map.get(key)!
    g.count++
    if (o.outlier_type === 'missed_timesheet') g.missed_timesheet++
    else if (o.outlier_type.startsWith('low_utilization')) g.low_utilization++
    else if (o.outlier_type === 'over_allocated') g.over_allocated++
  }
  return [...map.entries()]
    .map(([name, counts]) => ({ name, ...counts }))
    .sort((a, b) => b.count - a.count)
}

function deduplicateOutliers(outliers: OutlierEntry[]): OutlierEntry[] {
  const map = new Map<string, OutlierEntry>()
  for (const o of outliers) {
    const key = `${o.employee_code}:${o.outlier_type}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, o)
    } else {
      if (o.outlier_type === 'over_allocated') {
        if (o.metric_value > existing.metric_value) map.set(key, o)
      } else {
        if (o.metric_value < existing.metric_value) map.set(key, o)
      }
    }
  }
  return [...map.values()]
}

export const outliersRouter = Router()

outliersRouter.get('/', asyncHandler(async (req, res) => {
  const typeFilter = req.query.type as string | undefined
  const regionFilter = req.query.region as string | undefined
  const serviceLineFilter = (req.query.serviceLine as string) || (req.query.department as string)
  const from = parseISODate(req.query.from as string | undefined) ?? todayMonday()
  const to = parseISODate(req.query.to as string | undefined) ?? addWeeks(from, 4)

  const [outlierRes, allocRes, locationRes, tsCompRes, empDetailsRes] = await Promise.all([
    supabaseAdmin().rpc('fn_outliers', { p_from: from, p_to: to }),
    supabaseAdmin()
      .from('v_resource_allocation_grid')
      .select('emp_code, project_name, allocation_pct, allocation_status, week_start')
      .gte('week_start', from)
      .lte('week_start', to)
      .in('allocation_status', ['confirmed', 'proposed']),
    supabaseAdmin()
      .from('locations')
      .select('name, region:regions(name)'),
    supabaseAdmin()
      .from('timesheet_compliance')
      .select(`
        period_month, compliance_pct, total_hours,
        employees!inner(
          id, employee_id, name,
          designations(name),
          departments(name),
          locations(name)
        )
      `)
      .eq('compliance_pct', 0)
      .order('period_month', { ascending: false }),
    supabaseAdmin()
      .from('v_employee_details')
      .select('emp_code,region')
      .eq('is_active', true),
  ])

  if (outlierRes.error) return res.status(500).json({ error: outlierRes.error.message })

  const empRegionMap = new Map<string, string>()
  for (const emp of (empDetailsRes.data ?? [])) {
    if (emp.emp_code && emp.region) empRegionMap.set(emp.emp_code, emp.region)
  }

  const locationRegionMap = new Map<string, string>()
  for (const loc of (locationRes.data ?? [])) {
    const regionName = (loc.region as any)?.name ?? 'Unknown'
    locationRegionMap.set(loc.name, regionName)
  }

  const tsAllRows = tsCompRes.data ?? []
  const latestTsPeriod = tsAllRows.reduce((max: string, r: any) =>
    (r.period_month > max ? r.period_month : max), '')
  const strictTimesheetOutliers: OutlierEntry[] = tsAllRows
    .filter((r: any) => r.period_month === latestTsPeriod)
    .map((r: any) => {
      const emp = r.employees as any
      const loc = emp?.locations?.name ?? ''
      return {
        employee_id: emp?.id ?? '',
        employee_code: emp?.employee_id ?? '',
        employee_name: emp?.name ?? '',
        designation: emp?.designations?.name ?? '',
        department: emp?.departments?.name ?? '',
        location: loc,
        outlier_type: 'missed_timesheet',
        metric_value: Number(r.total_hours ?? 0),
        threshold: 1.0,
        detail: `Total hours = ${r.total_hours ?? 0} for period ${r.period_month}`,
        week_start: null,
        region: empRegionMap.get(emp?.employee_id ?? '') ?? locationRegionMap.get(loc) ?? 'Unknown',
        serviceLine: emp?.departments?.name ?? 'Unknown',
      }
    })

  let outliers: OutlierEntry[] = [
    ...strictTimesheetOutliers,
    ...((outlierRes.data ?? []) as OutlierEntry[]).filter(o => o.outlier_type !== 'missed_timesheet'),
  ]

  for (const o of outliers) {
    if (o.outlier_type !== 'missed_timesheet') {
      o.region = empRegionMap.get(o.employee_code) ?? locationRegionMap.get(o.location) ?? 'Unknown'
      o.serviceLine = o.department ?? 'Unknown'
    }
  }

  const empProjectMap = new Map<string, Map<string, { totalPct: number; status: string; weeks: number }>>()
  for (const row of (allocRes.data ?? [])) {
    if (!empProjectMap.has(row.emp_code)) empProjectMap.set(row.emp_code, new Map())
    const projMap = empProjectMap.get(row.emp_code)!
    const existing = projMap.get(row.project_name) ?? { totalPct: 0, status: row.allocation_status, weeks: 0 }
    existing.totalPct += Number(row.allocation_pct) || 0
    existing.weeks++
    projMap.set(row.project_name, existing)
  }

  for (const o of outliers) {
    const projMap = empProjectMap.get(o.employee_code)
    if (projMap) {
      o.projects = [...projMap.entries()].map(([name, info]) => ({
        name,
        allocation_pct: Math.round(info.totalPct / info.weeks),
        status: info.status,
      })).sort((a, b) => b.allocation_pct - a.allocation_pct)
    }
  }

  if (typeFilter) {
    const types = typeFilter.split(',').map(t => t.trim())
    outliers = outliers.filter(o => types.includes(o.outlier_type))
  }

  if (regionFilter) outliers = outliers.filter(o => o.region === regionFilter)
  if (serviceLineFilter) outliers = outliers.filter(o => o.serviceLine === serviceLineFilter)

  const deduped = deduplicateOutliers(outliers)

  const summary = {
    total: deduped.length,
    missed_timesheet: deduped.filter(o => o.outlier_type === 'missed_timesheet').length,
    low_utilization_am: deduped.filter(o => o.outlier_type === 'low_utilization_am').length,
    low_utilization_ad: deduped.filter(o => o.outlier_type === 'low_utilization_ad').length,
    over_allocated: deduped.filter(o => o.outlier_type === 'over_allocated').length,
  }

  const byRegion = groupBy(deduped, 'region')
  const byServiceLine = groupBy(deduped, 'serviceLine')
  const byDepartment = groupBy(deduped, 'department')

  res.json({
    summary,
    outliers: deduped,
    dateRange: { from, to },
    aggregations: { byRegion, byServiceLine, byDepartment },
  })
}))
