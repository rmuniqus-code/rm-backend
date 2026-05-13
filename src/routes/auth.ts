/**
 * Auth routes — mounted at /auth (public) and /api/admin (protected).
 *
 * POST /auth/register          — public self-signup, always gets 'employee' role
 * POST /api/admin/create-user  — admin only, creates user with any role + temp password
 *
 * Email verification is disabled (no SMTP configured).
 * Users can sign in immediately after registration.
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
    email_confirm: true, // no SMTP — skip verification, user can sign in immediately
  })

  if (error) return res.status(400).json({ error: error.message })

  return res.status(201).json({
    message: 'Account created. You can sign in now.',
  })
}))

// ── Admin: list all users ──────────────────────────────────────
adminRouter.get(
  '/users',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ perPage: 1000 })
    if (error) return res.status(500).json({ error: error.message })

    const users = (data?.users ?? []).map(u => ({
      id: u.id,
      email: u.email ?? '',
      name: (u.user_metadata?.name as string | undefined) ?? u.email ?? '',
      role: (u.app_metadata?.role as string | undefined) ?? 'employee',
      lastSignIn: u.last_sign_in_at ?? null,
      createdAt: u.created_at ?? null,
      confirmed: !!u.email_confirmed_at,
    }))

    return res.json({ users })
  }),
)

// ── Admin: update a user's role ───────────────────────────────
adminRouter.put(
  '/users/:userId/role',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }
    const { userId } = req.params
    const { role } = req.body as { role?: string }
    if (!role || !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${[...VALID_ROLES].join(', ')}` })
    }

    const { error } = await supabaseAdmin().auth.admin.updateUserById(userId, {
      app_metadata: { role },
    })
    if (error) return res.status(500).json({ error: error.message })

    return res.json({ success: true, userId, role })
  }),
)

// ── Admin: create user with specified role, sends invite email ──
adminRouter.post(
  '/create-user',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }

    const { email, name, role, tempPassword } = req.body as {
      email?: string
      name?: string
      role?: string
      tempPassword?: string
    }

    if (!email || !name || !role || !tempPassword) {
      return res.status(400).json({ error: 'email, name, role, and tempPassword are required' })
    }
    if (tempPassword.length < 8) {
      return res.status(400).json({ error: 'tempPassword must be at least 8 characters' })
    }
    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${[...VALID_ROLES].join(', ')}` })
    }

    const { data, error } = await supabaseAdmin().auth.admin.createUser({
      email,
      password: tempPassword,
      user_metadata: { name },
      app_metadata: { role },
      email_confirm: true, // no SMTP — account is immediately active
    })

    if (error) return res.status(400).json({ error: error.message })

    return res.status(201).json({
      message: `User created. Share these credentials with them — email: ${email}, temp password: ${tempPassword}`,
      userId: data.user?.id,
    })
  }),
)
