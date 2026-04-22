/**
 * Auth routes — mounted at /auth (public) and /api/admin (protected).
 *
 * POST /auth/register          — public self-signup, always gets 'employee' role
 * POST /api/admin/create-user  — admin only, creates user with any role + sends invite email
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'
import { requireAuth, type AuthedRequest } from '../middleware/auth'

export const authRouter = Router()
export const adminRouter = Router()

const VALID_ROLES = new Set(['admin', 'rm', 'slh', 'employee'])

// ── Public: self-registration ──────────────────────────────────
authRouter.post('/register', asyncHandler(async (req, res) => {
  const { email, password, name } = req.body as {
    email?: string
    password?: string
    name?: string
  }

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, and name are required' })
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }

  const { error } = await supabaseAdmin().auth.admin.createUser({
    email,
    password,
    user_metadata: { name },
    app_metadata: { role: 'employee' },
    email_confirm: false, // sends verification email
  })

  if (error) return res.status(400).json({ error: error.message })

  return res.status(201).json({
    message: 'Account created. Please check your email to verify your address before signing in.',
  })
}))

// ── Admin: create user with specified role, sends invite email ──
adminRouter.post(
  '/create-user',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const { email, name, role } = req.body as {
      email?: string
      name?: string
      role?: string
    }

    if (!email || !name || !role) {
      return res.status(400).json({ error: 'email, name, and role are required' })
    }
    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${[...VALID_ROLES].join(', ')}` })
    }

    // Create user without password — Supabase sends invite/magic-link email
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
      email,
      user_metadata: { name },
      app_metadata: { role },
      email_confirm: false,
    })

    if (error) return res.status(400).json({ error: error.message })

    return res.status(201).json({
      message: `Invite sent to ${email}. They will receive an email to set their password.`,
      userId: data.user?.id,
    })
  }),
)
