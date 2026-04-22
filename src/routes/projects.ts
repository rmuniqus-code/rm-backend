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
    .select('id, code, name, client, engagement_manager, engagement_partner, project_type, status, sub_team')
    .order('name')

  if (status && status !== 'all') projQuery = projQuery.eq('status', status)

  const { data: projects, error: projErr } = await projQuery
  if (projErr) return res.status(500).json({ error: projErr.message })

  const { data: allocRows, error: allocErr } = await supabaseAdmin()
    .from('v_resource_allocation_grid')
    .select('emp_code, employee_name, designation, sub_function, location, week_start, allocation_pct, allocation_status, project_name, project_client, engagement_manager, project_type')

  if (allocErr) return res.status(500).json({ error: allocErr.message })

  const projectAllocMap = new Map<string, {
    members: Map<string, { empCode: string; name: string; designation: string; location: string; allocPct: number }>
    weeks: Set<string>
    projectType: string
    client: string
    em: string
  }>()

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
  }

  const result: any[] = []

  for (const p of (projects ?? [])) {
    const allocInfo = projectAllocMap.get(p.name)
    const weekArr = allocInfo ? [...allocInfo.weeks].sort() : []
    const members = allocInfo ? [...allocInfo.members.values()] : []

    result.push({
      id: p.id,
      name: p.name,
      projectCode: p.code ?? '',
      client: p.client ?? allocInfo?.client ?? '',
      engagementManager: p.engagement_manager ?? allocInfo?.em ?? '',
      projectType: p.project_type ?? allocInfo?.projectType ?? 'chargeable',
      status: p.status ?? 'active',
      subTeam: p.sub_team ?? '',
      totalTeamMembers: members.length,
      firstWeek: weekArr[0] ?? null,
      lastWeek: weekArr[weekArr.length - 1] ?? null,
      activeWeeks: weekArr.length,
      teamMembers: members,
    })
  }

  for (const [pName, info] of projectAllocMap) {
    const alreadyIncluded = result.some(r => r.name === pName)
    if (!alreadyIncluded) {
      const weekArr = [...info.weeks].sort()
      const members = [...info.members.values()]
      result.push({
        id: `alloc-${pName.replace(/\s+/g, '-').toLowerCase()}`,
        name: pName,
        projectCode: '',
        client: info.client,
        engagementManager: info.em,
        projectType: info.projectType,
        status: 'active',
        subTeam: '',
        totalTeamMembers: members.length,
        firstWeek: weekArr[0] ?? null,
        lastWeek: weekArr[weekArr.length - 1] ?? null,
        activeWeeks: weekArr.length,
        teamMembers: members,
      })
    }
  }

  let filtered = result
  if (search) {
    const q = search.toLowerCase()
    filtered = result.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.client.toLowerCase().includes(q) ||
      p.engagementManager.toLowerCase().includes(q),
    )
  }

  filtered.sort((a: any, b: any) => b.totalTeamMembers - a.totalTeamMembers)

  res.json({ projects: filtered, total: filtered.length })
}))
