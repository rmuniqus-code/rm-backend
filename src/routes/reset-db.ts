/**
 * POST /api/reset-db — ported from app/api/reset-db/route.ts.
 * Only enabled when NODE_ENV=development.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'

export const resetDbRouter = Router()

resetDbRouter.post('/', asyncHandler(async (_req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Only available in development mode' })
  }

  const sb = supabaseAdmin()

  const del = (table: string) =>
    sb.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000')

  const errors: string[] = []

  const batch = async (tables: string[]) => {
    const results = await Promise.all(tables.map(t => del(t)))
    for (let i = 0; i < tables.length; i++) {
      if (results[i].error) errors.push(`${tables[i]}: ${results[i].error!.message}`)
    }
  }

  await batch(['file_uploads'])
  await batch(['timesheet_compliance', 'forecast_allocations', 'utilization_snapshots', 'resource_requests', 'upload_logs', 'notifications', 'audit_log'])
  await batch(['employees', 'projects'])
  await batch(['sub_functions', 'designations', 'locations'])
  await batch(['departments', 'regions'])

  if (errors.length > 0) {
    return res.status(207).json({ success: false, errors })
  }

  res.json({ success: true, message: 'All tables cleared' })
}))
