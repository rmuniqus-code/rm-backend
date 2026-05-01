/**
 * /api/bookings — live-edit endpoints for forecast_allocations.
 *
 * Lets an authenticated RM update an allocation row in place (allocation_pct,
 * allocation_status, project_id, week_start) rather than going through the
 * full request → approval flow. Every change is logged to audit_log so the
 * booking view can show who confirmed/updated the record and when.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'
import { logAuditDiff } from '../services/audit'

export const bookingsRouter = Router()

const EDITABLE_FIELDS = new Set([
  'allocation_pct',
  'allocation_status',
  'project_id',
  'week_start',
  'raw_text',
])

bookingsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'id is required' })

  const body = req.body as Record<string, unknown>

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of Object.keys(body)) {
    if (EDITABLE_FIELDS.has(key)) patch[key] = body[key]
  }
  if (Object.keys(patch).length === 1) {
    return res.status(400).json({ error: 'no editable fields in payload' })
  }

  const sb = supabaseAdmin()

  const { data: before, error: fetchErr } = await sb
    .from('forecast_allocations')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!before) return res.status(404).json({ error: 'allocation not found' })

  const { data: updated, error: updateErr } = await sb
    .from('forecast_allocations')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()
  if (updateErr) return res.status(500).json({ error: updateErr.message })

  await logAuditDiff(
    {
      entity: 'Allocation',
      entityId: id,
      entityName: (before as any)?.raw_text ?? null,
      action: 'Updated',
      userName: (req as any).user?.email ?? 'system',
    },
    before as Record<string, unknown>,
    updated as Record<string, unknown>,
    ['allocation_pct', 'allocation_status', 'project_id', 'week_start', 'raw_text'],
  )

  res.json({ allocation: updated })
}))

bookingsRouter.get('/:id/audit', asyncHandler(async (req, res) => {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'id is required' })

  const { data, error } = await supabaseAdmin()
    .from('audit_log')
    .select('*')
    .eq('entity', 'Allocation')
    .eq('entity_id', id)
    .order('created_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ entries: data ?? [] })
}))
