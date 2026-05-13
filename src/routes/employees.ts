/**
 * /api/employees — employee-level operations.
 *
 * GET  /:empCode/note  — fetch the confidential staff note for an employee
 * PUT  /:empCode/note  — upsert the note (admin / rm only)
 */

import { Router, type Response, type NextFunction } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler } from '../middleware/error'
import type { AuthedRequest } from '../middleware/auth'

export const employeesRouter = Router()

const EDITOR_ROLES = new Set(['admin', 'rm'])

function requireEditor(req: AuthedRequest, res: Response, next: NextFunction): void {
  const role = req.user?.role
  if (!role || !EDITOR_ROLES.has(role)) {
    res.status(403).json({ error: 'Forbidden — editor role required' })
    return
  }
  next()
}

async function resolveEmployeeId(empCode: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('employees')
    .select('id')
    .eq('employee_id', empCode)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

// ── GET /notes — all notes (admin / rm only) ──────────────────────────
employeesRouter.get('/notes', requireEditor, asyncHandler(async (req: AuthedRequest, res) => {
  const { data } = await supabaseAdmin()
    .from('employee_notes')
    .select('employee_id, note, updated_by, updated_at')

  // Resolve employee UUIDs → employee_id (emp codes)
  const uuids = (data ?? []).map((r: any) => r.employee_id)
  const { data: empRows } = await supabaseAdmin()
    .from('employees')
    .select('id, employee_id')
    .in('id', uuids)

  const codeById = new Map<string, string>()
  for (const e of empRows ?? []) codeById.set(e.id, e.employee_id)

  const notes: Record<string, string> = {}
  for (const r of data ?? []) {
    const code = codeById.get(r.employee_id)
    if (code && r.note) notes[code] = r.note
  }

  res.json({ notes })
}))

// ── GET /:empCode/note ─────────────────────────────────────────────────
employeesRouter.get('/:empCode/note', asyncHandler(async (req: AuthedRequest, res) => {
  const empCode = req.params.empCode
  const employeeId = await resolveEmployeeId(empCode)
  if (!employeeId) return res.status(404).json({ error: 'employee not found' })

  const { data } = await supabaseAdmin()
    .from('employee_notes')
    .select('note, updated_by, updated_at')
    .eq('employee_id', employeeId)
    .maybeSingle()

  res.json({ note: data?.note ?? '', updatedBy: data?.updated_by ?? null, updatedAt: data?.updated_at ?? null })
}))

// ── PUT /:empCode/note — admin / rm only ───────────────────────────────
employeesRouter.put('/:empCode/note', requireEditor, asyncHandler(async (req: AuthedRequest, res) => {
  const empCode = req.params.empCode
  const { note } = req.body ?? {}
  if (note === undefined) return res.status(400).json({ error: 'note is required' })

  const employeeId = await resolveEmployeeId(empCode)
  if (!employeeId) return res.status(404).json({ error: 'employee not found' })

  const updatedBy = req.user?.name ?? req.user?.email ?? 'system'

  const { data, error } = await supabaseAdmin()
    .from('employee_notes')
    .upsert({
      employee_id: employeeId,
      note: String(note),
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'employee_id' })
    .select('note, updated_by, updated_at')
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ note: data.note, updatedBy: data.updated_by, updatedAt: data.updated_at })
}))
