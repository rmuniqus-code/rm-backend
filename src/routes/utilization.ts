/**
 * GET /api/utilization — ported from app/api/utilization/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseISODate } from '../middleware/error'

export const utilizationRouter = Router()

utilizationRouter.get('/', asyncHandler(async (req, res) => {
  const employeeId = req.query.employeeId as string | undefined
  const from = parseISODate(req.query.from as string | undefined)
  const to = parseISODate(req.query.to as string | undefined)

  if (employeeId) {
    if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' })
    const { data, error } = await supabaseAdmin().rpc('fn_employee_utilization', {
      p_employee_id: employeeId,
      p_from: from,
      p_to: to,
    })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ employeeId, from, to, weeks: data })
  }

  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' })

  const location = req.query.location as string | undefined
  const grade = req.query.grade as string | undefined
  const department = req.query.department as string | undefined

  // Utilization = chargeable client work / available hours.
  // Filter to confirmed allocations on chargeable projects only — tentative
  // (proposed) work and internal/non-billable/training allocations must not
  // inflate the number.
  let query = supabaseAdmin()
    .from('v_resource_allocation_grid')
    .select('emp_code, employee_name, designation, department, location, week_start, allocation_pct, allocation_status, project_type, project_name')
    .gte('week_start', from)
    .lte('week_start', to)
    .eq('allocation_status', 'confirmed')

  if (location) query = query.eq('location', location)
  if (grade) query = query.eq('designation', grade)
  if (department) query = query.eq('department', department)

  const { data: rows, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  const NON_CHARGEABLE = new Set(['internal', 'non_chargeable', 'non-chargeable', 'training'])
  const isChargeable = (projectType: string | null | undefined, projectName: string | null | undefined) => {
    if (!projectName) return false // leaves / availability rows have no project
    const pt = (projectType ?? '').toLowerCase().trim()
    if (!pt) return true // default project_type is 'chargeable' per schema
    return !NON_CHARGEABLE.has(pt)
  }

  const empWeeklyUtil = new Map<string, { name: string; designation: string; weeks: Map<string, number> }>()

  for (const r of (rows ?? [])) {
    if (!isChargeable(r.project_type, r.project_name)) continue
    if (!empWeeklyUtil.has(r.emp_code)) {
      empWeeklyUtil.set(r.emp_code, { name: r.employee_name, designation: r.designation, weeks: new Map() })
    }
    const emp = empWeeklyUtil.get(r.emp_code)!
    const current = emp.weeks.get(r.week_start) ?? 0
    emp.weeks.set(r.week_start, current + Number(r.allocation_pct || 0))
  }

  const employeeUtils = [...empWeeklyUtil.entries()].map(([empCode, emp]) => {
    const weekValues = [...emp.weeks.values()]
    const avg = weekValues.length > 0
      ? weekValues.reduce((s, v) => s + v, 0) / weekValues.length
      : 0
    return { empCode, name: emp.name, designation: emp.designation, avgUtilization: Math.round(avg * 10) / 10 }
  })

  const overallAvg = employeeUtils.length > 0
    ? Math.round(employeeUtils.reduce((s, e) => s + e.avgUtilization, 0) / employeeUtils.length * 10) / 10
    : 0

  const byDesignation = new Map<string, { total: number; count: number }>()
  for (const e of employeeUtils) {
    const desg = e.designation || 'Unknown'
    if (!byDesignation.has(desg)) byDesignation.set(desg, { total: 0, count: 0 })
    const d = byDesignation.get(desg)!
    d.total += e.avgUtilization
    d.count++
  }
  const designationBreakdown = [...byDesignation.entries()].map(([designation, { total, count }]) => ({
    designation,
    avgUtilization: Math.round(total / count * 10) / 10,
    headcount: count,
  }))

  res.json({
    from, to,
    filters: { location, grade, department },
    overallUtilization: overallAvg,
    totalEmployees: employeeUtils.length,
    designationBreakdown,
    employees: employeeUtils.sort((a, b) => a.avgUtilization - b.avgUtilization),
  })
}))
