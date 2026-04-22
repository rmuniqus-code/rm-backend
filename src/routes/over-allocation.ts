/**
 * GET /api/over-allocation — ported from app/api/over-allocation/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseISODate } from '../middleware/error'

export const overAllocationRouter = Router()

overAllocationRouter.get('/', asyncHandler(async (req, res) => {
  const from = parseISODate(req.query.from as string | undefined)
  const to = parseISODate(req.query.to as string | undefined)

  if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' })

  const { data, error } = await supabaseAdmin().rpc('fn_over_allocated', {
    p_from: from,
    p_to: to,
  })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ from, to, conflicts: data, count: data?.length ?? 0 })
}))
