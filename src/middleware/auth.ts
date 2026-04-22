/**
 * Bearer-token auth. Verifies a Supabase access token sent by the frontend
 * and attaches the Supabase user to req.user.
 *
 * Frontend: obtain via supabase.auth.getSession() and send as
 *   Authorization: Bearer <access_token>
 */

import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'

let anonClient: ReturnType<typeof createClient> | null = null

function getAnonClient() {
  if (anonClient) return anonClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY')
  anonClient = createClient(url, key, { auth: { persistSession: false } })
  return anonClient
}

export interface AuthedRequest extends Request {
  user?: { id: string; email?: string; name: string; role: string }
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' })
    return
  }

  const { data, error } = await getAnonClient().auth.getUser(token)
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  const supaUser = data.user
  // Prefer full name from metadata, fall back to email prefix, then id
  const name: string =
    supaUser.user_metadata?.name ??
    supaUser.user_metadata?.full_name ??
    (supaUser.email ? supaUser.email.split('@')[0] : null) ??
    supaUser.id

  req.user = { id: supaUser.id, email: supaUser.email, name, role: supaUser.app_metadata?.role ?? 'employee' }
  next()
}
