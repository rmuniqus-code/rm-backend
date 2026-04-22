/**
 * /api/audit-log — ported from app/api/audit-log/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseInt32 } from '../middleware/error'

export const auditLogRouter = Router()

auditLogRouter.get('/', asyncHandler(async (req, res) => {
  const users = req.query.users as string | undefined
  const entity = req.query.entity as string | undefined
  const action = req.query.action as string | undefined
  const limit = parseInt32(req.query.limit as string | undefined, 50)
  const offset = parseInt32(req.query.offset as string | undefined, 0)

  let query = supabaseAdmin()
    .from('audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (users) {
    const userList = users.split(',').map(u => u.trim()).filter(Boolean)
    if (userList.length > 0) query = query.in('user_name', userList)
  }

  if (entity) query = query.eq('entity', entity)
  if (action) query = query.eq('action', action)

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })

  const { data: userNames } = await supabaseAdmin()
    .from('audit_log')
    .select('user_name')
    .order('user_name')

  const distinctUsers = [...new Set((userNames ?? []).map((r: any) => r.user_name))].filter(Boolean)

  res.json({ entries: data ?? [], total: count ?? 0, limit, offset, users: distinctUsers })
}))

auditLogRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {}

  const { data, error } = await supabaseAdmin()
    .from('audit_log')
    .insert({
      user_name: body.user_name,
      user_id: body.user_id ?? null,
      action: body.action,
      entity: body.entity,
      entity_name: body.entity_name ?? null,
      entity_id: body.entity_id ?? null,
      field: body.field ?? null,
      old_value: body.old_value ?? null,
      new_value: body.new_value ?? null,
      metadata: body.metadata ?? {},
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
}))
