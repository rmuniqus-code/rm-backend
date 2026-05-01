/**
 * GET /api/projects — ported from app/api/projects/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'

export const projectsRouter = Router()

projectsRouter.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status as string | undefined
  const search = req.query.search as string | undefined

  let projQuery = supabaseAdmin()
    .from('projects')
    .select('id, code, name, client, engagement_manager, engagement_partner, project_type, status, sub_team, start_date, end_date')
    .order('name')

  if (status && status !== 'all') projQuery = projQuery.eq('status', status)

  const { data: projects, error: projErr } = await projQuery
  if (projErr) return res.status(500).json({ error: projErr.message })

  const { data: allocRows, error: allocErr } = await supabaseAdmin()
    .from('v_resource_allocation_grid')
    .select('emp_code, employee_name, designation, sub_function, location, week_start, allocation_pct, allocation_status, project_name, project_client, engagement_manager, engagement_partner, project_type')

  if (allocErr) return res.status(500).json({ error: allocErr.message })

  // Hours on a single (emp, week) are capped at 40 regardless of allocation_pct
  // sum, to avoid double-counting when multiple rows exist for the same slot.
  const HOURS_PER_WEEK = 40

  type ProjectAgg = {
    members: Map<string, { empCode: string; name: string; designation: string; location: string; allocPct: number }>
    weeks: Set<string>
    projectType: string
    client: string
    em: string
    ep: string
    // Per (emp, week) summed allocation_pct — used to derive hours without duplicates
    weeklyLoad: Map<string, number>
  }

  const projectAllocMap = new Map<string, ProjectAgg>()

  for (const row of (allocRows ?? [])) {
    const pName = row.project_name
    if (!pName) continue

    if (!projectAllocMap.has(pName)) {
      projectAllocMap.set(pName, {
        members: new Map(),
        weeks: new Set(),
        projectType: row.project_type ?? 'chargeable',
        client: row.project_client ?? '',
        em: row.engagement_manager ?? '',
        ep: row.engagement_partner ?? '',
        weeklyLoad: new Map(),
      })
    }
    const entry = projectAllocMap.get(pName)!
    entry.weeks.add(row.week_start)

    const existing = entry.members.get(row.emp_code)
    const pct = Number(row.allocation_pct) || 0
    if (!existing || pct > existing.allocPct) {
      entry.members.set(row.emp_code, {
        empCode: row.emp_code,
        name: row.employee_name,
        designation: row.designation ?? '',
        location: row.location ?? '',
        allocPct: pct,
      })
    }

    const slotKey = `${row.emp_code}|${row.week_start}`
    entry.weeklyLoad.set(slotKey, (entry.weeklyLoad.get(slotKey) ?? 0) + pct)
  }

  const buildProjectRow = (base: {
    id: string
    name: string
    projectCode: string
    client: string
    engagementManager: string
    engagementPartner: string
    projectType: string
    status: string
    subTeam: string
    startDate: string | null
    endDate: string | null
  }) => {
    const info = projectAllocMap.get(base.name)
    const weekArr = info ? [...info.weeks].sort() : []
    const members = info ? [...info.members.values()] : []

    // Total booked hours: for each (emp, week) slot take min(sumPct, 100) and convert to hours
    let totalHours = 0
    if (info) {
      for (const pct of info.weeklyLoad.values()) {
        totalHours += (Math.min(pct, 100) / 100) * HOURS_PER_WEEK
      }
    }

    // Grade breakdown
    const gradeMap = new Map<string, number>()
    for (const m of members) {
      const g = m.designation || 'Unknown'
      gradeMap.set(g, (gradeMap.get(g) ?? 0) + 1)
    }
    const gradeBreakdown = [...gradeMap.entries()]
      .map(([grade, count]) => ({ grade, count }))
      .sort((a, b) => b.count - a.count)

    // Duration (weeks) derived from allocations. Prefer actual DB start/end if available.
    const durationWeeks = weekArr.length
    const durationFrom = base.startDate ?? weekArr[0] ?? null
    const durationTo = base.endDate ?? weekArr[weekArr.length - 1] ?? null

    return {
      ...base,
      totalTeamMembers: members.length,
      firstWeek: weekArr[0] ?? null,
      lastWeek: weekArr[weekArr.length - 1] ?? null,
      activeWeeks: weekArr.length,
      totalHoursBooked: Math.round(totalHours),
      duration: { from: durationFrom, to: durationTo, weeks: durationWeeks },
      gradeBreakdown,
      teamMembers: members,
    }
  }

  const result: any[] = []

  for (const p of (projects ?? [])) {
    const allocInfo = projectAllocMap.get(p.name)
    result.push(buildProjectRow({
      id: p.id,
      name: p.name,
      projectCode: p.code ?? '',
      client: p.client ?? allocInfo?.client ?? '',
      engagementManager: p.engagement_manager ?? allocInfo?.em ?? '',
      engagementPartner: p.engagement_partner ?? allocInfo?.ep ?? '',
      projectType: p.project_type ?? allocInfo?.projectType ?? 'chargeable',
      status: p.status ?? 'active',
      subTeam: p.sub_team ?? '',
      startDate: p.start_date ?? null,
      endDate: p.end_date ?? null,
    }))
  }

  for (const [pName, info] of projectAllocMap) {
    const alreadyIncluded = result.some(r => r.name === pName)
    if (!alreadyIncluded) {
      result.push(buildProjectRow({
        id: `alloc-${pName.replace(/\s+/g, '-').toLowerCase()}`,
        name: pName,
        projectCode: '',
        client: info.client,
        engagementManager: info.em,
        engagementPartner: info.ep,
        projectType: info.projectType,
        status: 'active',
        subTeam: '',
        startDate: null,
        endDate: null,
      }))
    }
  }

  let filtered = result
  if (search) {
    const q = search.toLowerCase()
    filtered = result.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.client.toLowerCase().includes(q) ||
      p.engagementManager.toLowerCase().includes(q) ||
      (p.engagementPartner ?? '').toLowerCase().includes(q),
    )
  }

  filtered.sort((a: any, b: any) => b.totalTeamMembers - a.totalTeamMembers)

  res.json({ projects: filtered, total: filtered.length })
}))
