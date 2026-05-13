/**
 * /api/allocations — inline allocation management.
 *
 * Backend-driven CRUD for forecast_allocations rows so the resource
 * timeline can edit / extend / delete / restatus an allocation, or
 * assign a project into an empty cell, without doing direct DB writes
 * from the frontend.
 *
 * Every action is audited and gated by role (admin | rm).
 *
 * Endpoints (all POST):
 *   /create   — assign a project (or status) into one or more weeks
 *   /update   — change pct / status / project for an existing row
 *   /delete   — remove allocation rows (by id, or by emp+project+weeks)
 *   /extend   — extend an existing allocation forward by N weeks
 *   /status   — change status to 'proposed' | 'confirmed'
 *
 * Identification: callers can pass either `id` (forecast_allocations.id)
 * or the natural key triple { empCode, projectName | null, weekStart }.
 */

import { Router, type Response, type NextFunction } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'
import { logAudit, logAuditDiff } from '../services/audit'
import { notifyAllocationAction, resolveEmployeeIdByEmail } from '../services/notify'
import type { AuthedRequest } from '../middleware/auth'

// Format a Date as YYYY-MM-DD using LOCAL time — never toISOString() which uses UTC.
function safeISODate(d: Date): string {
  const y  = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

export const allocationsRouter = Router()

// ── Role gate ──────────────────────────────────────────────────────────
const EDITOR_ROLES = new Set(['admin', 'rm'])

function requireEditor(req: AuthedRequest, res: Response, next: NextFunction): void {
  const role = req.user?.role
  if (!role || !EDITOR_ROLES.has(role)) {
    res.status(403).json({ error: 'Forbidden — editor role required' })
    return
  }
  next()
}

allocationsRouter.use(requireEditor)

// ── Helpers ────────────────────────────────────────────────────────────

const VALID_STATUSES = new Set([
  'confirmed', 'proposed', 'available', 'leave',
  'jip', 'maternity', 'unconfirmed', 'leaver',
])

function isIsoMonday(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  // Use local midnight (no Z suffix) so the day-of-week check matches the
  // timezone the frontend uses when generating the date string.
  // Using 'T00:00:00Z' (UTC midnight) would misclassify Monday dates in UTC+
  // zones like IST (+5:30) as Sunday and silently drop the weekStart filter.
  const dt = new Date(d + 'T00:00:00')
  return !Number.isNaN(dt.getTime()) && dt.getDay() === 1
}

function addWeeks(iso: string, n: number): string {
  const dt = new Date(iso + 'T00:00:00')
  dt.setDate(dt.getDate() + 7 * n)
  return safeISODate(dt)
}

async function resolveEmployeeId(input: { id?: string; empCode?: string }): Promise<string | null> {
  if (input.id) return input.id
  if (!input.empCode) return null
  const { data } = await supabaseAdmin()
    .from('employees')
    .select('id')
    .eq('employee_id', input.empCode)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

async function resolveProjectId(input: { id?: string | null; name?: string | null }): Promise<string | null> {
  if (input.id) return input.id
  if (!input.name) return null
  // Use ilike (case-insensitive exact match) to be resilient to casing differences
  // between what the Excel parser stores and what appears on the resource screen.
  const { data } = await supabaseAdmin()
    .from('projects')
    .select('id')
    .ilike('name', input.name.trim())
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

// Look up display names so audit entries are human-readable in the audit-trail
// page ("Priya Kapoor → Acme Portal") instead of opaque uuids.
async function fetchEmployeeName(employeeId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('employees')
    .select('name, employee_id')
    .eq('id', employeeId)
    .maybeSingle()
  return (data?.name as string | undefined) ?? (data?.employee_id as string | undefined) ?? null
}

async function fetchProjectName(projectId: string | null): Promise<string | null> {
  if (!projectId) return null
  const { data } = await supabaseAdmin()
    .from('projects')
    .select('name')
    .eq('id', projectId)
    .maybeSingle()
  return (data?.name as string | undefined) ?? null
}

function allocationLabel(empName: string | null, projectOrStatus: string | null | undefined): string {
  const left = empName ?? '(unknown)'
  const right = projectOrStatus ?? '(no project)'
  return `${left} → ${right}`
}

function pluralWeeks(n: number): string {
  return `${n} week${n === 1 ? '' : 's'}`
}

interface AllocationRow {
  id: string
  employee_id: string
  project_id: string | null
  week_start: string
  allocation_pct: number
  allocation_status: string
  raw_text: string | null
}

async function findAllocation(opts: {
  id?: string
  employeeId?: string
  projectId?: string | null
  weekStart?: string
}): Promise<AllocationRow | null> {
  const sb = supabaseAdmin()
  if (opts.id) {
    const { data } = await sb.from('forecast_allocations').select('*').eq('id', opts.id).maybeSingle()
    return (data as AllocationRow | null) ?? null
  }
  if (!opts.employeeId || !opts.weekStart) return null
  let q = sb.from('forecast_allocations').select('*')
    .eq('employee_id', opts.employeeId)
    .eq('week_start', opts.weekStart)
  q = opts.projectId ? q.eq('project_id', opts.projectId) : q.is('project_id', null)
  const { data } = await q.maybeSingle()
  return (data as AllocationRow | null) ?? null
}

function actor(req: AuthedRequest): { userName: string } {
  return { userName: req.user?.name ?? req.user?.email ?? 'system' }
}

// ── Project code generation ───────────────────────────────────────────
const SL_PREFIX_MAP: Record<string, string> = {
  ARC: 'ARC', ADVISORY: 'ADV', CONSULTING: 'CON', TAX: 'TAX',
  TECHNOLOGY: 'TCH', GRC: 'GRC', SCC: 'SCC', AUDIT: 'ARC',
  FORENSICS: 'FOR', RISK: 'RSK',
}

function serviceLinePrefix(hint: string): string {
  const h = (hint ?? '').trim().toUpperCase()
  for (const [key, code] of Object.entries(SL_PREFIX_MAP)) {
    if (h.startsWith(key) || h.includes(key)) return code
  }
  const clean = h.replace(/[^A-Z]/g, '')
  return (clean.slice(0, 3) || 'GEN').padEnd(3, 'X')
}

async function generateProjectCode(serviceLineHint: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = serviceLinePrefix(serviceLineHint)
  const { data } = await supabaseAdmin()
    .from('projects')
    .select('code')
    .like('code', `%-${year}-%`)
  const maxSeq = (data ?? []).reduce((max: number, p: { code: string | null }) => {
    const parts = (p.code ?? '').split('-')
    const seq = parts.length >= 3 ? (parseInt(parts[parts.length - 1]) || 0) : 0
    return Math.max(max, seq)
  }, 0)
  return `${prefix}-${year}-${String(maxSeq + 1).padStart(3, '0')}`
}

// ── POST /create ───────────────────────────────────────────────────────
// body: { empCode | employeeId, projectName | projectId | null,
//         weekStarts: string[], allocationPct?, allocationStatus? }
allocationsRouter.post('/create', asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body ?? {}
  const weekStarts: string[] = Array.isArray(body.weekStarts) ? body.weekStarts : []
  if (weekStarts.length === 0 || !weekStarts.every(isIsoMonday)) {
    return res.status(400).json({ error: 'weekStarts must be a non-empty array of ISO Monday dates' })
  }
  const status = (body.allocationStatus ?? 'confirmed') as string
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: `invalid allocationStatus: ${status}` })
  }
  const pct = Number(body.allocationPct ?? 100)
  if (!Number.isFinite(pct) || pct < 0) {
    return res.status(400).json({ error: 'allocationPct must be 0 or greater' })
  }

  const employeeId = await resolveEmployeeId({ id: body.employeeId, empCode: body.empCode })
  if (!employeeId) return res.status(404).json({ error: 'employee not found' })

  let projectId = await resolveProjectId({ id: body.projectId ?? null, name: body.projectName ?? null })
  if ((body.projectName || body.projectId) && !projectId) {
    if (body.autoCreateProject && body.projectName) {
      // Auto-create a new project with a generated dummy code
      const code = await generateProjectCode(body.serviceLineHint ?? '')
      const { data: newProj, error: createErr } = await supabaseAdmin()
        .from('projects')
        .insert({ name: body.projectName.trim(), code, status: 'active', sub_team: body.serviceLineHint ?? null })
        .select('id')
        .single()
      if (createErr) return res.status(500).json({ error: createErr.message })
      projectId = (newProj as { id: string }).id
    } else {
      return res.status(404).json({ error: 'project not found' })
    }
  }

  const sb = supabaseAdmin()
  const rows = weekStarts.map(w => ({
    employee_id: employeeId,
    project_id: projectId,
    week_start: w,
    allocation_pct: pct,
    allocation_status: status,
    raw_text: body.rawText ?? null,
  }))

  // Replace any existing rows on the same (emp, project, week) before inserting.
  let del = sb.from('forecast_allocations').delete()
    .eq('employee_id', employeeId)
    .in('week_start', weekStarts)
  del = projectId ? del.eq('project_id', projectId) : del.is('project_id', null)
  const { error: delErr } = await del
  if (delErr) return res.status(500).json({ error: delErr.message })

  const { data: inserted, error: insErr } = await sb
    .from('forecast_allocations').insert(rows).select('*')
  if (insErr) return res.status(500).json({ error: insErr.message })

  const empName = await fetchEmployeeName(employeeId)
  const projDisplay = body.projectName ?? (projectId ? await fetchProjectName(projectId) : null) ?? status
  const sortedWeeks = [...weekStarts].sort()
  const changeDesc = `${pluralWeeks(weekStarts.length)} at ${pct}% ${status} (${sortedWeeks[0]}${weekStarts.length > 1 ? ` – ${sortedWeeks[sortedWeeks.length - 1]}` : ''})`
  await logAudit({
    ...actor(req),
    action: 'Created',
    entity: 'Allocation',
    entityName: allocationLabel(empName, projDisplay),
    entityId: employeeId,
    field: 'allocation',
    newValue: changeDesc,
    metadata: {
      employee: empName, employeeId,
      project: projDisplay, projectId,
      weekStarts: sortedWeeks,
      allocationPct: pct,
      allocationStatus: status,
      rowsCreated: inserted?.length ?? 0,
    },
  })

  const actorEmployeeId = await resolveEmployeeIdByEmail(req.user?.email)
  await notifyAllocationAction({
    action: 'created',
    employeeName: empName,
    projectName: projDisplay,
    change: `assigned for ${changeDesc}`,
    resourceEmployeeId: employeeId,
    actorEmployeeId,
    actorName: actor(req).userName,
    relatedEntityId: employeeId,
  })

  res.json({ allocations: inserted ?? [] })
}))

// ── POST /update ───────────────────────────────────────────────────────
// body: { id?, empCode?, projectName?, weekStart?,
//         patch: { allocationPct?, allocationStatus?, projectName?, weekStart? } }
allocationsRouter.post('/update', asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body ?? {}
  const patch = (body.patch ?? {}) as Record<string, unknown>
  if (!patch || Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'patch object is required' })
  }

  const employeeId = body.id ? undefined : await resolveEmployeeId({ empCode: body.empCode })
  const projectIdLookup = body.projectName !== undefined
    ? await resolveProjectId({ name: body.projectName })
    : undefined

  // Guard: if caller identified the row by project name but we can't find that project,
  // bail out early rather than letting findAllocation search for project_id IS NULL rows.
  if (body.projectName !== undefined && body.projectName !== null && projectIdLookup === null) {
    return res.status(404).json({ error: 'project not found' })
  }

  const before = await findAllocation({
    id: body.id,
    employeeId: employeeId ?? undefined,
    projectId: projectIdLookup ?? null,
    weekStart: body.weekStart,
  })
  if (!before) return res.status(404).json({ error: 'allocation not found' })

  const next: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.allocationPct !== undefined) {
    const n = Number(patch.allocationPct)
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'allocationPct must be 0 or greater' })
    next.allocation_pct = n
  }
  if (patch.allocationStatus !== undefined) {
    const s = String(patch.allocationStatus)
    if (!VALID_STATUSES.has(s)) return res.status(400).json({ error: `invalid allocationStatus: ${s}` })
    next.allocation_status = s
  }
  if (patch.weekStart !== undefined) {
    const w = String(patch.weekStart)
    if (!isIsoMonday(w)) return res.status(400).json({ error: 'patch.weekStart must be an ISO Monday' })
    next.week_start = w
  }
  if (patch.projectName !== undefined) {
    const newProjectId = await resolveProjectId({ name: patch.projectName as string | null })
    if (patch.projectName && !newProjectId) return res.status(404).json({ error: 'project not found' })
    next.project_id = newProjectId
  } else if (patch.projectId !== undefined) {
    next.project_id = patch.projectId
  }
  if (patch.rawText !== undefined) next.raw_text = patch.rawText

  if (Object.keys(next).length === 1) {
    return res.status(400).json({ error: 'no editable fields in patch' })
  }

  const { data: updated, error } = await supabaseAdmin()
    .from('forecast_allocations').update(next).eq('id', before.id).select('*').single()
  if (error) return res.status(500).json({ error: error.message })

  const empName = await fetchEmployeeName(before.employee_id)
  const projDisplay = body.projectName
    ?? (await fetchProjectName(before.project_id))
    ?? before.allocation_status
  await logAuditDiff(
    {
      ...actor(req),
      action: 'Updated',
      entity: 'Allocation',
      entityId: before.id,
      entityName: allocationLabel(empName, projDisplay),
      metadata: {
        employee: empName, employeeId: before.employee_id,
        project: projDisplay, projectId: before.project_id,
        weekStart: before.week_start,
      },
    },
    before as unknown as Record<string, unknown>,
    updated as Record<string, unknown>,
    ['allocation_pct', 'allocation_status', 'project_id', 'week_start', 'raw_text'],
  )

  // Build a human-readable summary of what changed
  const changes: string[] = []
  if (next.allocation_pct !== undefined) changes.push(`load → ${next.allocation_pct}%`)
  if (next.allocation_status !== undefined) changes.push(`status → ${next.allocation_status}`)
  if (next.week_start !== undefined) changes.push(`week → ${next.week_start}`)
  const updateDesc = changes.length > 0 ? changes.join(', ') : 'updated'

  const actorEmployeeId = await resolveEmployeeIdByEmail(req.user?.email)
  await notifyAllocationAction({
    action: 'updated',
    employeeName: empName,
    projectName: projDisplay,
    change: `${updateDesc} (week of ${before.week_start})`,
    resourceEmployeeId: before.employee_id,
    actorEmployeeId,
    actorName: actor(req).userName,
    relatedEntityId: before.id,
  })

  res.json({ allocation: updated })
}))

// ── Day-mask helpers ───────────────────────────────────────────────────

/** Return the Monday (week-start) for any ISO date string using local time. */
function toMondayISO(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  const dow = d.getDay() // 0=Sun … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + diff)
  return safeISODate(d)
}

/** bit position for Mon=0 … Fri=4 */
function dayBit(iso: string): number {
  const dow = new Date(iso + 'T00:00:00').getDay() // 1=Mon … 5=Fri
  if (dow < 1 || dow > 5) return 0  // weekends: no bit
  return 1 << (dow - 1)
}

// ── POST /delete ───────────────────────────────────────────────────────
// body: { id?, empCode?, projectName?, weekStarts?: string[], dates?: string[] }
// `weekStarts` → delete entire week rows (existing behaviour)
// `dates`      → remove specific days from their week rows via days_mask;
//                delete the row when days_mask reaches 0
allocationsRouter.post('/delete', asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body ?? {}
  const sb = supabaseAdmin()

  if (body.id) {
    const { data: before } = await sb.from('forecast_allocations').select('*').eq('id', body.id).maybeSingle()
    if (!before) return res.status(404).json({ error: 'allocation not found' })
    const beforeRow = before as AllocationRow
    const { error } = await sb.from('forecast_allocations').delete().eq('id', body.id)
    if (error) return res.status(500).json({ error: error.message })
    const empName = await fetchEmployeeName(beforeRow.employee_id)
    const projDisplay = (await fetchProjectName(beforeRow.project_id)) ?? beforeRow.allocation_status
    await logAudit({
      ...actor(req),
      action: 'Deleted',
      entity: 'Allocation',
      entityId: body.id,
      entityName: allocationLabel(empName, projDisplay),
      field: 'allocation',
      oldValue: `${beforeRow.allocation_pct}% ${beforeRow.allocation_status} (week of ${beforeRow.week_start})`,
      newValue: 'deleted',
      metadata: {
        employee: empName, employeeId: beforeRow.employee_id,
        project: projDisplay, projectId: beforeRow.project_id,
        weekStart: beforeRow.week_start,
        allocationPct: beforeRow.allocation_pct,
        allocationStatus: beforeRow.allocation_status,
      },
    })
    const actorEmpId = await resolveEmployeeIdByEmail(req.user?.email)
    await notifyAllocationAction({
      action: 'deleted',
      employeeName: empName,
      projectName: projDisplay,
      change: `removed from ${projDisplay} (week of ${beforeRow.week_start})`,
      resourceEmployeeId: beforeRow.employee_id,
      actorEmployeeId: actorEmpId,
      actorName: actor(req).userName,
      relatedEntityId: body.id,
    })
    return res.json({ deleted: 1 })
  }

  const employeeId = await resolveEmployeeId({ empCode: body.empCode })
  if (!employeeId) return res.status(404).json({ error: 'employee not found' })

  // ── Day-level delete path ────────────────────────────────────────────
  if (Array.isArray(body.dates) && body.dates.length > 0) {
    const dates: string[] = body.dates
    const projectId = body.projectName !== undefined
      ? await resolveProjectId({ name: body.projectName })
      : undefined

    // Group dates by their Monday week-start
    const byWeek = new Map<string, number>()  // weekStart → combined bits to clear
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
      const monday = toMondayISO(d)
      const bit = dayBit(d)
      if (!bit) continue
      byWeek.set(monday, (byWeek.get(monday) ?? 0) | bit)
    }

    if (byWeek.size === 0) return res.json({ deleted: 0 })

    let totalDeleted = 0
    const empName = await fetchEmployeeName(employeeId)
    const projDisplay = body.projectName ?? '(all projects)'

    for (const [monday, clearBits] of byWeek.entries()) {
      let q = sb.from('forecast_allocations')
        .select('id,days_mask')
        .eq('employee_id', employeeId)
        .eq('week_start', monday)
      if (projectId !== undefined) q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null)

      const { data: rows, error: fetchErr } = await q
      if (fetchErr || !rows) continue

      for (const row of rows as { id: string; days_mask: number | null }[]) {
        const currentMask = row.days_mask ?? 31
        const newMask = currentMask & ~clearBits & 0x1f  // clear bits, keep 5-bit range

        if (newMask === 0) {
          await sb.from('forecast_allocations').delete().eq('id', row.id)
          totalDeleted++
        } else if (newMask !== currentMask) {
          await sb.from('forecast_allocations').update({ days_mask: newMask }).eq('id', row.id)
          totalDeleted++
        }
      }
    }

    const sortedDates = [...dates].sort()
    await logAudit({
      ...actor(req),
      action: 'Deleted',
      entity: 'Allocation',
      entityName: allocationLabel(empName, projDisplay),
      entityId: employeeId,
      field: 'allocation',
      newValue: `removed ${dates.length} day${dates.length !== 1 ? 's' : ''} (${sortedDates[0]}${dates.length > 1 ? ` – ${sortedDates.at(-1)}` : ''})`,
      metadata: { employee: empName, project: projDisplay, dates: sortedDates },
    })

    return res.json({ deleted: totalDeleted })
  }

  // ── Week-level delete path (existing) ───────────────────────────────
  const weekStarts: string[] = Array.isArray(body.weekStarts) ? body.weekStarts : []
  if (weekStarts.length === 0 || !weekStarts.every(isIsoMonday)) {
    return res.status(400).json({ error: 'weekStarts must be ISO Monday dates' })
  }
  const projectId = body.projectName !== undefined
    ? await resolveProjectId({ name: body.projectName })
    : undefined

  let q = sb.from('forecast_allocations').select('*')
    .eq('employee_id', employeeId)
    .in('week_start', weekStarts)
  if (projectId !== undefined) q = projectId ? q.eq('project_id', projectId) : q.is('project_id', null)
  const { data: rowsToDelete, error: fetchErr } = await q
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })

  if (!rowsToDelete || rowsToDelete.length === 0) {
    return res.json({ deleted: 0 })
  }

  const ids = rowsToDelete.map((r: any) => r.id)
  const { error: delErr } = await sb.from('forecast_allocations').delete().in('id', ids)
  if (delErr) return res.status(500).json({ error: delErr.message })

  const empName = await fetchEmployeeName(employeeId)
  const projDisplay = body.projectName
    ?? (projectId ? await fetchProjectName(projectId) : null)
    ?? '(multiple)'
  const sortedDel = [...weekStarts].sort()
  await logAudit({
    ...actor(req),
    action: 'Deleted',
    entity: 'Allocation',
    entityName: allocationLabel(empName, projDisplay),
    entityId: employeeId,
    field: 'allocation',
    newValue: `deleted ${pluralWeeks(ids.length)} (${sortedDel[0]}${weekStarts.length > 1 ? ` – ${sortedDel[sortedDel.length - 1]}` : ''})`,
    metadata: {
      employee: empName, employeeId,
      project: projDisplay, projectId,
      weekStarts: sortedDel,
      rowsDeleted: ids.length,
      ids,
    },
  })

  const actorEmpIdDel = await resolveEmployeeIdByEmail(req.user?.email)
  await notifyAllocationAction({
    action: 'deleted',
    employeeName: empName,
    projectName: projDisplay,
    change: `removed for ${pluralWeeks(ids.length)} (${sortedDel[0]}${weekStarts.length > 1 ? ` – ${sortedDel[sortedDel.length - 1]}` : ''})`,
    resourceEmployeeId: employeeId,
    actorEmployeeId: actorEmpIdDel,
    actorName: actor(req).userName,
    relatedEntityId: employeeId,
  })

  res.json({ deleted: ids.length })
}))

// ── POST /extend ───────────────────────────────────────────────────────
// body: { empCode, projectName, fromWeekStart, byWeeks?, throughWeekStart?, allocationPct? }
//
// Adds rows for week_start = fromWeekStart + 7*1 .. fromWeekStart + 7*N
// using the same project + status + (override) pct as the source row.
allocationsRouter.post('/extend', asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body ?? {}
  if (!body.fromWeekStart || !isIsoMonday(body.fromWeekStart)) {
    return res.status(400).json({ error: 'fromWeekStart must be an ISO Monday' })
  }

  const employeeId = await resolveEmployeeId({ empCode: body.empCode })
  if (!employeeId) return res.status(404).json({ error: 'employee not found' })
  const projectId = body.projectName ? await resolveProjectId({ name: body.projectName }) : null

  const source = await findAllocation({
    employeeId, projectId, weekStart: body.fromWeekStart,
  })
  if (!source) return res.status(404).json({ error: 'source allocation not found' })

  let weeks: string[] = []
  if (typeof body.byWeeks === 'number' && body.byWeeks > 0) {
    for (let i = 1; i <= body.byWeeks; i++) weeks.push(addWeeks(body.fromWeekStart, i))
  } else if (body.throughWeekStart && isIsoMonday(body.throughWeekStart)) {
    let next = addWeeks(body.fromWeekStart, 1)
    while (next <= body.throughWeekStart) { weeks.push(next); next = addWeeks(next, 1) }
  } else {
    return res.status(400).json({ error: 'pass byWeeks (>0) or throughWeekStart' })
  }
  if (weeks.length === 0) return res.json({ allocations: [] })

  const pct = body.allocationPct !== undefined ? Number(body.allocationPct) : Number(source.allocation_pct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ error: 'allocationPct must be 0–100' })
  }

  const sb = supabaseAdmin()
  let del = sb.from('forecast_allocations').delete()
    .eq('employee_id', employeeId)
    .in('week_start', weeks)
  del = projectId ? del.eq('project_id', projectId) : del.is('project_id', null)
  await del

  const rows = weeks.map(w => ({
    employee_id: employeeId,
    project_id: projectId,
    week_start: w,
    allocation_pct: pct,
    allocation_status: source.allocation_status,
    raw_text: source.raw_text,
  }))
  const { data: inserted, error } = await sb.from('forecast_allocations').insert(rows).select('*')
  if (error) return res.status(500).json({ error: error.message })

  const empName = await fetchEmployeeName(employeeId)
  const projDisplay = body.projectName
    ?? (projectId ? await fetchProjectName(projectId) : null)
    ?? source.allocation_status
  const extendDesc = `extended +${pluralWeeks(weeks.length)} at ${pct}% ${source.allocation_status} (through ${weeks[weeks.length - 1]})`
  await logAudit({
    ...actor(req),
    action: 'Updated',
    entity: 'Allocation',
    entityName: allocationLabel(empName, projDisplay),
    entityId: employeeId,
    field: 'allocation',
    newValue: extendDesc,
    metadata: {
      employee: empName, employeeId,
      project: projDisplay, projectId,
      extendedFrom: body.fromWeekStart,
      addedWeeks: weeks,
      allocationPct: pct,
      allocationStatus: source.allocation_status,
    },
  })

  const actorEmpIdExt = await resolveEmployeeIdByEmail(req.user?.email)
  await notifyAllocationAction({
    action: 'extended',
    employeeName: empName,
    projectName: projDisplay,
    change: extendDesc,
    resourceEmployeeId: employeeId,
    actorEmployeeId: actorEmpIdExt,
    actorName: actor(req).userName,
    relatedEntityId: employeeId,
  })

  res.json({ allocations: inserted ?? [] })
}))

// ── POST /status ───────────────────────────────────────────────────────
// body: { id? OR (empCode, projectName, weekStart),
//         status: 'proposed' | 'confirmed',
//         applyToAllWeeks?: boolean }   // if true, change status for all weeks
//                                       // of (emp, project) >= weekStart
allocationsRouter.post('/status', asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body ?? {}
  const status = String(body.status ?? '')
  if (status !== 'proposed' && status !== 'confirmed') {
    return res.status(400).json({ error: 'status must be proposed or confirmed' })
  }

  const sb = supabaseAdmin()

  if (body.id && !body.applyToAllWeeks) {
    const { data: before } = await sb.from('forecast_allocations').select('*').eq('id', body.id).maybeSingle()
    if (!before) return res.status(404).json({ error: 'allocation not found' })
    const beforeRow = before as AllocationRow
    const { data: updated, error } = await sb
      .from('forecast_allocations')
      .update({ allocation_status: status, updated_at: new Date().toISOString() })
      .eq('id', body.id).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    const empName = await fetchEmployeeName(beforeRow.employee_id)
    const projDisplay = (await fetchProjectName(beforeRow.project_id)) ?? beforeRow.allocation_status
    await logAudit({
      ...actor(req),
      action: 'Updated',
      entity: 'Allocation',
      entityId: body.id,
      entityName: allocationLabel(empName, projDisplay),
      field: 'allocation_status',
      oldValue: beforeRow.allocation_status,
      newValue: status,
      metadata: {
        employee: empName, employeeId: beforeRow.employee_id,
        project: projDisplay, projectId: beforeRow.project_id,
        weekStart: beforeRow.week_start,
      },
    })
    const actorEmpIdSt = await resolveEmployeeIdByEmail(req.user?.email)
    await notifyAllocationAction({
      action: 'status_changed',
      employeeName: empName,
      projectName: projDisplay,
      change: `status changed from ${beforeRow.allocation_status} to ${status} (week of ${beforeRow.week_start})`,
      resourceEmployeeId: beforeRow.employee_id,
      actorEmployeeId: actorEmpIdSt,
      actorName: actor(req).userName,
      relatedEntityId: body.id,
    })
    return res.json({ allocation: updated, updated: 1 })
  }

  const employeeId = await resolveEmployeeId({ empCode: body.empCode })
  if (!employeeId) return res.status(404).json({ error: 'employee not found' })
  if (!body.projectName) return res.status(400).json({ error: 'projectName required' })
  const projectId = await resolveProjectId({ name: body.projectName })
  if (!projectId) return res.status(404).json({ error: 'project not found' })

  // weekStart is required for the natural-key path. Without it, falling back to
  // an unfiltered (emp, project) update would silently flip status for every
  // week the resource is on this project — which is never what the timeline UI
  // wants. Require an explicit Monday; broadening to >= weekStart is opt-in via
  // applyToAllWeeks. Caller wanting a single-row update by id can use the id path above.
  if (!body.weekStart || !isIsoMonday(body.weekStart)) {
    return res.status(400).json({ error: 'weekStart (ISO Monday) is required for the natural-key path' })
  }
  let q = sb.from('forecast_allocations').select('*')
    .eq('employee_id', employeeId)
    .eq('project_id', projectId)
  q = body.applyToAllWeeks ? q.gte('week_start', body.weekStart) : q.eq('week_start', body.weekStart)
  const { data: matches, error: fetchErr } = await q
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!matches || matches.length === 0) return res.json({ updated: 0, allocations: [] })

  const ids = matches.map((r: any) => r.id)
  // Capture the previous statuses per row so the audit log shows the "from" value.
  const prevStatuses = matches.map((r: any) => (r as AllocationRow).allocation_status)
  const { data: updated, error } = await sb
    .from('forecast_allocations')
    .update({ allocation_status: status, updated_at: new Date().toISOString() })
    .in('id', ids).select('*')
  if (error) return res.status(500).json({ error: error.message })

  const empName = await fetchEmployeeName(employeeId)
  const projDisplay = body.projectName ?? (await fetchProjectName(projectId))
  // Log one audit entry per changed row so each resource→project change is traceable.
  await Promise.all(ids.map((id: string, i: number) => logAudit({
    ...actor(req),
    action: 'Updated',
    entity: 'Allocation',
    entityId: id,
    entityName: allocationLabel(empName, projDisplay),
    field: 'allocation_status',
    oldValue: prevStatuses[i] ?? undefined,
    newValue: status,
    metadata: {
      employee: empName, employeeId,
      project: projDisplay, projectId,
      weekStart: (matches[i] as AllocationRow).week_start,
      applyToAllWeeks: !!body.applyToAllWeeks,
    },
  })))

  const actorEmpIdSt2 = await resolveEmployeeIdByEmail(req.user?.email)
  const weekRange = ids.length === 1
    ? `week of ${(matches[0] as AllocationRow).week_start}`
    : `${pluralWeeks(ids.length)} from ${body.weekStart}`
  await notifyAllocationAction({
    action: 'status_changed',
    employeeName: empName,
    projectName: projDisplay,
    change: `status → ${status} (${weekRange})`,
    resourceEmployeeId: employeeId,
    actorEmployeeId: actorEmpIdSt2,
    actorName: actor(req).userName,
    relatedEntityId: employeeId,
  })

  res.json({ allocations: updated ?? [], updated: ids.length })
}))
