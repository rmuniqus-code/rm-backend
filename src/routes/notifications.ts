/**
 * /api/notifications — ported from app/api/notifications/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseInt32 } from '../middleware/error'

export const notificationsRouter = Router()

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const unreadOnly = req.query.unread_only === 'true'
  const limit = parseInt32(req.query.limit as string | undefined, 20)

  let query = supabaseAdmin()
    .from('notifications')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(limit)

  if (unreadOnly) query = query.eq('is_read', false)

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })

  const unreadCount = unreadOnly
    ? (count ?? 0)
    : (data?.filter((n: any) => !n.is_read).length ?? 0)

  res.json({ notifications: data ?? [], total: count ?? 0, unreadCount })
}))

notificationsRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {}

  const required = ['type', 'title', 'message']
  const missing = required.filter(f => !body[f])
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` })

  const { data, error } = await supabaseAdmin()
    .from('notifications')
    .insert({
      type: body.type,
      title: body.title,
      message: body.message,
      recipient_id: body.recipient_id ?? null,
      related_entity_type: body.related_entity_type ?? null,
      related_entity_id: body.related_entity_id ?? null,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
}))

notificationsRouter.patch('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {}

  if (body.mark_all) {
    const { error } = await supabaseAdmin()
      .from('notifications')
      .update({ is_read: true })
      .eq('is_read', false)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true, message: 'All notifications marked as read' })
  }

  if (body.ids && Array.isArray(body.ids)) {
    const { error } = await supabaseAdmin()
      .from('notifications')
      .update({ is_read: true })
      .in('id', body.ids)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ success: true, updated: body.ids.length })
  }

  res.status(400).json({ error: 'Provide either { mark_all: true } or { ids: [...] }' })
}))

notificationsRouter.delete('/', asyncHandler(async (_req, res) => {
  const { error } = await supabaseAdmin()
    .from('notifications')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000')

  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true, message: 'All notifications cleared' })
}))
