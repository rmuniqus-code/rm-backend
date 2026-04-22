/**
 * GET /api/exports/:type — ported from app/api/exports/[type]/route.ts.
 */

import { Router } from 'express'
import { supabaseAdmin } from '../db/supabase-admin'
import { asyncHandler, parseISODate } from '../middleware/error'

const ALLOWED = new Set(['employees', 'allocations', 'utilization'])

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const escape = (v: unknown): string => {
    if (v == null) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
  ]
  return lines.join('\r\n')
}

export const exportsRouter = Router()

exportsRouter.get('/:type', asyncHandler(async (req, res) => {
  const type = req.params.type
  if (!ALLOWED.has(type)) return res.status(400).json({ error: `Unknown export type: ${type}` })

  const sb = supabaseAdmin()
  let rows: Record<string, unknown>[] = []
  let filename = `${type}.csv`

  if (type === 'employees') {
    const { data, error } = await sb.from('v_employee_details').select('*')
    if (error) return res.status(500).json({ error: error.message })
    rows = data ?? []
  } else if (type === 'allocations') {
    const from = parseISODate(req.query.from as string | undefined)
    const to = parseISODate(req.query.to as string | undefined)
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' })

    const { data, error } = await sb
      .from('v_resource_allocation_grid')
      .select('*')
      .gte('week_start', from)
      .lte('week_start', to)
    if (error) return res.status(500).json({ error: error.message })
    rows = data ?? []
    filename = `allocations_${from}_to_${to}.csv`
  } else if (type === 'utilization') {
    const period = req.query.period as string | undefined
    let q = sb.from('v_compliance_overview').select('*')
    if (period) q = q.eq('period_month', period)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    rows = data ?? []
    filename = period ? `utilization_${period}.csv` : `utilization.csv`
  }

  const csv = toCSV(rows)
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(csv)
}))
