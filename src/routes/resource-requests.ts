/**
 * /api/resource-requests — list/create, detail/update/delete, approve.
 * Ported from app/api/resource-requests/route.ts + [id]/route.ts + [id]/approve/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseInt32 } from '../middleware/error'
import { notifyRequestRaised, notifyBookingConfirmed } from '../services/notify'
import { logAudit, logAuditDiff } from '../services/audit'
import type { AuthedRequest } from '../middleware/auth'

function weekStartsBetween(from: string, to: string): string[] {
  const result: string[] = []
  const start = new Date(from)
  const end = new Date(to)

  const day = start.getUTCDay()
  const offset = (day === 0 ? -6 : 1 - day)
  start.setUTCDate(start.getUTCDate() + offset)

  while (start <= end) {
    result.push(start.toISOString().split('T')[0])
    start.setUTCDate(start.getUTCDate() + 7)
  }
  return result
}

export const resourceRequestsRouter = Router()

// ── GET / — list ──────────────────────────────────────────────
resourceRequestsRouter.get('/', asyncHandler(async (req, res) => {
  const status = req.query.status as string | undefined
  const projectId = req.query.projectId as string | undefined
  const limit = parseInt32(req.query.limit as string | undefined, 50)
  const offset = parseInt32(req.query.offset as string | undefined, 0)

  let query = supabaseAdmin()
    .from('resource_requests')
    .select(`
      id, request_number, request_type, booking_type, approval_status,
      resource_requested,
      start_date, end_date, hours_per_day, total_hours,
      role_needed, grade_needed, primary_skill, notes, created_at,
      opportunity_id, skill_set, travel_requirements, project_status,
      loading_pct, em_ep_name, lifecycle_status,
      service_line, sub_service_line,
      project:projects(id, name, client, code, zoho_project_id),
      requester:employees!resource_requests_requested_by_fkey(id, name, employee_id)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq('approval_status', status)
  if (projectId) query = query.eq('project_id', projectId)

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: count ?? 0, limit, offset })
}))

// ── POST / — create ───────────────────────────────────────────
resourceRequestsRouter.post('/', asyncHandler(async (req: AuthedRequest, res) => {
  const body = req.body ?? {}

  const required = ['role_needed', 'start_date', 'end_date']
  const missing = required.filter(f => !body[f])
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` })

  let projectId = body.project_id ?? null
  if (!projectId && body.project_name) {
    const { data: existing } = await supabaseAdmin()
      .from('projects')
      .select('id')
      .ilike('name', body.project_name)
      .limit(1)
      .single()

    if (existing) {
      projectId = existing.id
    } else {
      const { data: created } = await supabaseAdmin()
        .from('projects')
        .insert({ name: body.project_name, engagement_manager: body.em_ep_name ?? null })
        .select('id')
        .single()
      projectId = created?.id ?? null
    }
  }

  const { data, error } = await supabaseAdmin()
    .from('resource_requests')
    .insert({
      project_id: projectId,
      resource_requested: body.resource_requested ?? null,
      request_type: body.request_type ?? 'New Staff',
      booking_type: body.booking_type ?? 'tentative',
      requested_by: body.requested_by ?? null,
      start_date: body.start_date,
      end_date: body.end_date,
      hours_per_day: body.hours_per_day ?? 8,
      total_hours: body.total_hours ?? null,
      role_needed: body.role_needed,
      grade_needed: body.grade_needed ?? null,
      primary_skill: body.primary_skill ?? null,
      notes: body.notes ?? null,
      opportunity_id: body.opportunity_id ?? null,
      skill_set: body.skill_set ?? null,
      travel_requirements: body.travel_requirements ?? null,
      project_status: body.project_status ?? null,
      loading_pct: body.loading_pct ?? 100,
      em_ep_name: body.em_ep_name ?? null,
      service_line: body.service_line ?? null,
      sub_service_line: body.sub_service_line ?? null,
      lifecycle_status: 'submitted',
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  notifyRequestRaised(
    data.id,
    body.project_name ?? 'Unknown Project',
    body.role_needed,
  )

  logAudit({
    action: 'Created',
    entity: 'Request',
    entityName: `#${data.request_number} — ${body.project_name ?? 'Unknown Project'}`,
    entityId: data.id,
    userName: req.user?.name ?? 'System',
    field: 'request',
    newValue: `${body.role_needed} | ${body.start_date} – ${body.end_date}`,
    metadata: {
      projectName: body.project_name,
      roleNeeded: body.role_needed,
      startDate: body.start_date,
      endDate: body.end_date,
      hoursPerDay: body.hours_per_day ?? 8,
      loadingPct: body.loading_pct ?? 100,
      resourceRequested: body.resource_requested ?? null,
    },
  })

  res.status(201).json(data)
}))

// ── GET /:id ──────────────────────────────────────────────────
resourceRequestsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id
  const { data, error } = await supabaseAdmin()
    .from('resource_requests')
    .select(`
      *,
      project:projects(id, name, client, engagement_manager),
      requester:employees!resource_requests_requested_by_fkey(id, name, employee_id),
      approver:employees!resource_requests_approved_by_fkey(id, name, employee_id)
    `)
    .eq('id', id)
    .single()

  if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message })
  res.json(data)
}))

// ── PATCH /:id ────────────────────────────────────────────────
resourceRequestsRouter.patch('/:id', asyncHandler(async (req: AuthedRequest, res) => {
  const id = req.params.id
  const body = req.body ?? {}
  const sb = supabaseAdmin()

  const { data: before } = await sb
    .from('resource_requests')
    .select('*, project:projects(name)')
    .eq('id', id)
    .single()

  const editable = [
    'resource_requested', 'request_type', 'booking_type',
    'start_date', 'end_date', 'hours_per_day', 'total_hours',
    'role_needed', 'grade_needed', 'primary_skill', 'notes',
    'opportunity_id', 'skill_set',
    'travel_requirements', 'project_status', 'loading_pct',
    'em_ep_name', 'service_line', 'sub_service_line',
  ]
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const f of editable) {
    if (f in body) update[f] = body[f]
  }

  const { data, error } = await sb
    .from('resource_requests')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  if (before) {
    const projectName = (before as any).project?.name ?? 'Unknown Project'

    if (body.resource_requested && body.resource_requested !== before.resource_requested) {
      logAudit({
        action: 'Assigned',
        entity: 'Request',
        entityName: `#${before.request_number} — ${projectName}`,
        entityId: id,
        userName: req.user?.name ?? 'System',
        field: 'resource_requested',
        oldValue: before.resource_requested ?? 'Unassigned',
        newValue: body.resource_requested,
      })
    } else {
      logAuditDiff(
        {
          action: 'Updated',
          entity: 'Request',
          entityName: `#${before.request_number} — ${projectName}`,
          entityId: id,
          userName: req.user?.name ?? 'System',
        },
        before,
        body,
        editable,
      )
    }
  }

  res.json(data)
}))

// ── DELETE /:id ───────────────────────────────────────────────
resourceRequestsRouter.delete('/:id', asyncHandler(async (req: AuthedRequest, res) => {
  const id = req.params.id
  const sb = supabaseAdmin()

  const { data: before } = await sb
    .from('resource_requests')
    .select('request_number, project:projects(name), role_needed')
    .eq('id', id)
    .single()

  const { error } = await sb.from('resource_requests').delete().eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  if (before) {
    logAudit({
      action: 'Deleted',
      entity: 'Request',
      entityName: `#${(before as any).request_number} — ${(before as any).project?.name ?? 'Unknown'}`,
      entityId: id,
      userName: req.user?.name ?? 'System',
      field: 'request',
      oldValue: (before as any).role_needed ?? '',
    })
  }

  res.json({ deleted: true })
}))

// ── POST /:id/approve ─────────────────────────────────────────
resourceRequestsRouter.post('/:id/approve', asyncHandler(async (req: AuthedRequest, res) => {
  const id = req.params.id
  const body = req.body ?? {}

  const decision = body.decision as 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' })
  }

  const sb = supabaseAdmin()

  const { data: request, error: fetchErr } = await sb
    .from('resource_requests')
    .select('*, project:projects(name)')
    .eq('id', id)
    .single()

  if (fetchErr || !request) return res.status(404).json({ error: 'Request not found' })

  const projectName = (request as any).project?.name ?? 'Unknown Project'

  if (decision === 'rejected') {
    const { error: updateErr } = await sb
      .from('resource_requests')
      .update({
        approval_status: 'rejected',
        lifecycle_status: 'rejected',
        notes: body.notes ?? undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateErr) return res.status(500).json({ error: updateErr.message })

    logAudit({
      action: 'Rejected',
      entity: 'Request',
      entityName: `#${request.request_number} — ${projectName}`,
      entityId: id,
      userName: req.user?.name ?? 'System',
      field: 'approval_status',
      oldValue: request.approval_status ?? 'pending',
      newValue: 'rejected',
    })

    return res.json({ request: { ...request, approval_status: 'rejected', lifecycle_status: 'rejected' }, allocationsCreated: 0 })
  }

  const allocatedName = body.allocated_employee
    ? String(body.allocated_employee).trim()
    : request.resource_requested
      ? String(request.resource_requested).trim()
      : null

  if (!allocatedName) {
    return res.status(400).json({ error: 'Approval requires an allocated employee. Provide allocated_employee or ensure resource_requested is set on the request.' })
  }

  let empRow: { id: string } | null = null
  const { data: byId } = await sb
    .from('employees')
    .select('id')
    .eq('employee_id', allocatedName)
    .limit(1)
    .maybeSingle()
  if (byId) {
    empRow = byId as { id: string }
  } else {
    const { data: byName } = await sb
      .from('employees')
      .select('id')
      .ilike('name', allocatedName)
      .limit(1)
      .maybeSingle()
    empRow = byName as { id: string } | null
  }

  if (!empRow) {
    return res.status(400).json({ error: `Employee "${allocatedName}" not found. Cannot approve without a valid resource allocation.` })
  }
  const emp = empRow

  if (!request.start_date || !request.end_date) {
    return res.status(400).json({ error: 'Request must have start_date and end_date to approve.' })
  }

  const weeks = weekStartsBetween(request.start_date, request.end_date)
  if (weeks.length === 0) {
    return res.status(400).json({ error: 'No valid weeks found between start_date and end_date.' })
  }

  const bodyHpd = (typeof body.hours_per_day === 'number' && body.hours_per_day > 0)
    ? body.hours_per_day : null
  const reqLoadingPct = (request.loading_pct != null && Number(request.loading_pct) > 0)
    ? Math.min(200, Number(request.loading_pct)) : null
  const reqHpd = (request.hours_per_day && request.hours_per_day > 0)
    ? request.hours_per_day : null

  const pct = bodyHpd !== null
    ? Math.min(200, (bodyHpd / 8) * 100)
    : reqLoadingPct ?? (reqHpd !== null ? Math.min(200, (reqHpd / 8) * 100) : 100)

  const rows = weeks.map(w => ({
    employee_id: emp.id,
    project_id: request.project_id,
    week_start: w,
    allocation_pct: pct,
    allocation_status: 'confirmed' as const,
    raw_text: `Approved request #${request.request_number}`,
    source_file: 'resource_request_approval',
  }))

  await sb.from('forecast_allocations')
    .delete()
    .eq('employee_id', emp.id)
    .eq('project_id', request.project_id)
    .in('week_start', weeks)

  const { error: insertErr } = await sb.from('forecast_allocations').insert(rows)
  if (insertErr) return res.status(500).json({ error: `Allocation creation failed: ${insertErr.message}` })

  const allocationsCreated = rows.length

  const updatePayload: Record<string, unknown> = {
    approval_status: 'approved',
    lifecycle_status: 'approved',
    notes: body.notes ?? undefined,
    updated_at: new Date().toISOString(),
  }
  if (body.approved_by) updatePayload.approved_by = body.approved_by

  if (body.allocated_employee) {
    updatePayload.resource_requested = allocatedName
    updatePayload.hours_per_day = (pct / 100) * 8
  }

  const { data: updatedRequest, error: updateErr } = await sb
    .from('resource_requests')
    .update(updatePayload)
    .eq('id', id)
    .select('*, project:projects(name)')
    .single()

  if (updateErr) return res.status(500).json({ error: updateErr.message })

  logAudit({
    action: 'Approved',
    entity: 'Request',
    entityName: `#${request.request_number} — ${projectName}`,
    entityId: id,
    userName: req.user?.name ?? 'System',
    field: 'approval_status',
    oldValue: request.approval_status ?? 'pending',
    newValue: 'approved',
    metadata: {
      allocatedEmployee: allocatedName,
      allocationsCreated,
      hoursPerDay: (pct / 100) * 8,
    },
  })

  logAudit({
    action: 'Created',
    entity: 'Allocation',
    entityName: `${allocatedName} → ${projectName}`,
    entityId: id,
    userName: req.user?.name ?? 'System',
    field: 'allocation',
    newValue: `${allocationsCreated} weeks confirmed`,
    metadata: {
      employee: allocatedName,
      project: projectName,
      weeks: allocationsCreated,
      startDate: request.start_date,
      endDate: request.end_date,
    },
  })

  notifyBookingConfirmed(
    allocatedName,
    projectName,
    request.start_date,
    request.end_date,
  )

  res.json({ request: updatedRequest, allocationsCreated })
}))

// ── POST /:id/shortlist ───────────────────────────────────────
// Mark a candidate against a request without yet creating allocations.
// Use this when the RM wants to pencil someone in before confirming a booking
// (R2 — "shortlist resource as an option — directly gets booked on the tool").
resourceRequestsRouter.post('/:id/shortlist', asyncHandler(async (req: AuthedRequest, res) => {
  const id = req.params.id
  const body = req.body ?? {}
  const sb = supabaseAdmin()

  const { data: before, error: fetchErr } = await sb
    .from('resource_requests')
    .select('*, project:projects(name)')
    .eq('id', id)
    .single()
  if (fetchErr || !before) return res.status(404).json({ error: 'Request not found' })

  const resourceName = (body.resource_name ?? body.resource_requested ?? null) as string | null

  const { data: updated, error: updateErr } = await sb
    .from('resource_requests')
    .update({
      approval_status: 'shortlisted',
      resource_requested: resourceName ?? before.resource_requested,
      notes: body.notes ?? before.notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()
  if (updateErr) return res.status(500).json({ error: updateErr.message })

  const projectName = (before as any).project?.name ?? 'Unknown Project'
  logAudit({
    action: 'Updated',
    entity: 'Request',
    entityName: `#${before.request_number} — ${projectName}`,
    entityId: id,
    userName: req.user?.name ?? 'System',
    field: 'approval_status',
    oldValue: before.approval_status ?? 'pending',
    newValue: 'shortlisted',
    metadata: resourceName ? { shortlisted_resource: resourceName } : undefined,
  })

  res.json({ request: updated })
}))

// ── POST /:id/undo ───────────────────────────────────────────
// Revert the request to the state it was in before the most recent audit entry
// (R1 — "Unable to undo any changes"). Only reverts editable fields; booking
// allocations created by /approve must be reversed manually for now.
resourceRequestsRouter.post('/:id/undo', asyncHandler(async (req: AuthedRequest, res) => {
  const id = req.params.id
  const sb = supabaseAdmin()

  const { data: auditRows, error: auditErr } = await sb
    .from('audit_log')
    .select('*')
    .eq('entity', 'Request')
    .eq('entity_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
  if (auditErr) return res.status(500).json({ error: auditErr.message })

  const last = auditRows?.[0]
  if (!last) return res.status(404).json({ error: 'No audit history to undo' })

  const revert: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const changes = (last.metadata as any)?.changes as Array<{ field: string; from: unknown; to: unknown }> | undefined

  if (changes && changes.length > 0) {
    for (const c of changes) {
      revert[c.field] = c.from
    }
  } else if (last.field && last.old_value !== undefined) {
    revert[last.field] = last.old_value
  } else {
    return res.status(400).json({ error: 'Latest audit entry has no reversible changes' })
  }

  const { data: updated, error: updateErr } = await sb
    .from('resource_requests')
    .update(revert)
    .eq('id', id)
    .select()
    .single()
  if (updateErr) return res.status(500).json({ error: updateErr.message })

  logAudit({
    action: 'Updated',
    entity: 'Request',
    entityName: last.entity_name ?? `#${updated.request_number}`,
    entityId: id,
    userName: req.user?.name ?? 'System',
    field: 'undo',
    metadata: { revertedAuditId: last.id, revertedFields: Object.keys(revert).filter(k => k !== 'updated_at') },
  })

  res.json({ request: updated, reverted: revert })
}))
