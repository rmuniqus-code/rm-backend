/**
 * GET /api/file-uploads — ported from app/api/file-uploads/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'

export const fileUploadsRouter = Router()

fileUploadsRouter.get('/', asyncHandler(async (req, res) => {
  const fileType = req.query.file_type as string | undefined
  const version = req.query.version as string | undefined

  let query = supabaseAdmin()
    .from('file_uploads')
    .select('*')
    .order('created_at', { ascending: false })

  if (fileType) query = query.eq('file_type', fileType)
  if (version) query = query.eq('version', parseInt(version))

  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json({ files: data ?? [] })
}))
