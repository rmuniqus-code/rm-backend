/**
 * Role-Permissions CRUD
 *
 * GET  /api/role-permissions          — all rows (public read for UI)
 * PATCH /api/role-permissions/toggle  — toggle a single (role_id, permission_id)
 *        Body: { roleId: string; permissionId: string }
 *        Requires admin role.
 */

import { Router, type Response, type NextFunction } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'
import type { AuthedRequest } from '../middleware/auth'

export const rolePermissionsRouter = Router()

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden — admin role required' })
    return
  }
  next()
}

/* ── GET all rows ── */
rolePermissionsRouter.get('/', asyncHandler(async (_req, res) => {
  const { data, error } = await supabaseAdmin()
    .from('role_permissions')
    .select('role_id, permission_id, granted, updated_by, updated_at')
    .order('role_id')

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ permissions: data ?? [] })
}))

/* ── PATCH toggle ── */
rolePermissionsRouter.patch('/toggle', requireAdmin, asyncHandler(async (req: AuthedRequest, res) => {
  const { roleId, permissionId } = req.body as { roleId: string; permissionId: string }

  if (!roleId || !permissionId) {
    return res.status(400).json({ error: 'roleId and permissionId are required' })
  }

  const sb = supabaseAdmin()

  // Fetch current value
  const { data: existing } = await sb
    .from('role_permissions')
    .select('granted')
    .eq('role_id', roleId)
    .eq('permission_id', permissionId)
    .maybeSingle()

  const newGranted = !(existing?.granted ?? false)
  const userEmail = req.user?.email ?? 'unknown'

  const { data: updated, error } = await sb
    .from('role_permissions')
    .upsert(
      { role_id: roleId, permission_id: permissionId, granted: newGranted, updated_by: userEmail, updated_at: new Date().toISOString() },
      { onConflict: 'role_id,permission_id' }
    )
    .select('role_id, permission_id, granted, updated_by, updated_at')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ permission: updated })
}))
