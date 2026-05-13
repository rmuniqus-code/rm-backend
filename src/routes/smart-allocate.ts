/**
 * GET /api/smart-allocate
 * Ported from app/api/smart-allocate/route.ts.
 */

import { Router } from 'express'
import { getSupabase } from '../services/ingestion/ingest'
import { asyncHandler } from '../middleware/error'

function toLocalISO(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

function mondayOf(d: Date): string {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const m = new Date(d)
  m.setDate(d.getDate() + diff)
  m.setHours(0, 0, 0, 0)
  return toLocalISO(m)
}

function addWeeks(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n * 7)
  return toLocalISO(d)
}

const ALLOC_PAGE = 1000
const BOOKED_STATUSES = ['confirmed', 'proposed', 'unconfirmed']

export const smartAllocateRouter = Router()

smartAllocateRouter.get('/', asyncHandler(async (req, res) => {
  const primarySkill = (req.query.primarySkill as string) ?? ''
  const gradeFilter = (req.query.grade as string) ?? ''
  const today = new Date()
  const fromISO = (req.query.startDate as string) ?? mondayOf(today)
  const toISO = (req.query.endDate as string) ?? addWeeks(mondayOf(today), 4)

  // primarySkill is optional — when absent, return all active employees ranked by availability

  const sb = getSupabase()

  const { data: empRows, error: empError } = await sb
    .from('v_employee_details')
    .select('emp_code,name,designation,department,sub_function,location,region')
    .eq('is_active', true)
    .order('name')
  if (empError) return res.status(500).json({ error: empError.message })

  // Fetch UUIDs and primary_skill so shortlisting can store the proper FK reference
  const { data: empDetailRows } = await sb
    .from('employees')
    .select('id,employee_id,primary_skill,years_experience,certifications,languages')
  const uuidByEmpCode = new Map<string, string>()
  const profileByEmpCode = new Map<string, { primarySkillDb: string; yearsExperience: number | null; certifications: string | null; languages: string | null }>()
  for (const r of empDetailRows ?? []) {
    if (r.employee_id) {
      uuidByEmpCode.set(r.employee_id, r.id)
      profileByEmpCode.set(r.employee_id, {
        primarySkillDb: r.primary_skill ?? '',
        yearsExperience: r.years_experience ?? null,
        certifications: r.certifications ?? null,
        languages: r.languages ?? null,
      })
    }
  }

  // Fetch confidential employee notes (shown to RM/admin when shortlisting)
  const { data: noteRows } = await sb
    .from('employee_notes')
    .select('employee_id,note')
  const noteByUUID = new Map<string, string>()
  for (const n of noteRows ?? []) {
    if (n.employee_id && n.note) noteByUUID.set(n.employee_id, n.note)
  }

  const { data: skillRows } = await sb
    .from('v_employee_skills')
    .select('emp_code,primary_skill')

  const skillMap = new Map<string, string>()
  for (const s of skillRows ?? []) {
    if (s.emp_code && s.primary_skill) skillMap.set(s.emp_code, s.primary_skill)
  }

  const { data: desRows } = await sb
    .from('designations')
    .select('name,rank_order')

  const gradeRank = new Map<string, number>()
  for (const d of desRows ?? []) {
    if (d.name) gradeRank.set(d.name, d.rank_order ?? 0)
  }

  const allocRows: any[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await sb
      .from('v_resource_allocation_grid')
      .select('emp_code,allocation_pct,week_start,allocation_status')
      .gte('week_start', fromISO)
      .lte('week_start', toISO)
      .in('allocation_status', BOOKED_STATUSES)
      .range(offset, offset + ALLOC_PAGE - 1)

    if (error) return res.status(500).json({ error: error.message })
    if (!data || data.length === 0) break
    allocRows.push(...data)
    if (data.length < ALLOC_PAGE) break
    offset += ALLOC_PAGE
  }

  const weekTotals = new Map<string, Map<string, number>>()
  for (const row of allocRows) {
    if (!weekTotals.has(row.emp_code)) weekTotals.set(row.emp_code, new Map())
    const wMap = weekTotals.get(row.emp_code)!
    wMap.set(row.week_start, (wMap.get(row.week_start) ?? 0) + (row.allocation_pct ?? 0))
  }

  const avgUtil = new Map<string, number>()
  for (const [empCode, wMap] of weekTotals.entries()) {
    const total = Array.from(wMap.values()).reduce((a, b) => a + b, 0)
    avgUtil.set(empCode, Math.round(total / wMap.size))
  }

  const requestedRank = gradeFilter ? (gradeRank.get(gradeFilter) ?? -1) : -1

  const candidates: any[] = []

  // Whether any employees have skill mappings at all (skill mapping file may not have been uploaded)
  const hasSkillData = skillMap.size > 0

  for (const emp of empRows ?? []) {
    const empSkill = skillMap.get(emp.emp_code) ?? ''

    // Skill scoring: if a primarySkill was requested and skill data exists, only include
    // employees whose primary skill matches (exact, case-insensitive).
    // If no primarySkill requested OR no skill data has been uploaded, include everyone.
    let skillScore = 0
    if (primarySkill && hasSkillData) {
      if (empSkill.toLowerCase() !== primarySkill.toLowerCase()) continue
      skillScore = 50
    } else if (primarySkill && !hasSkillData) {
      // Skill data not loaded yet — include everyone with 0 skill score
      skillScore = 0
    } else {
      // No skill filter — small bonus for having ANY skill mapped
      skillScore = empSkill ? 20 : 0
    }

    const util = avgUtil.get(emp.emp_code) ?? 0
    if (util > 100) continue

    let availScore = 0
    if (util <= 50) availScore = 30
    else if (util <= 80) availScore = 20
    else availScore = 10

    let gradeScore = 0
    if (gradeFilter && emp.designation) {
      if (emp.designation === gradeFilter) {
        gradeScore = 20
      } else {
        const empRank = gradeRank.get(emp.designation) ?? -99
        if (requestedRank >= 0 && empRank >= 0 && Math.abs(empRank - requestedRank) === 1) {
          gradeScore = 10
        }
      }
    }

    const fitScore = Math.min(skillScore + availScore + gradeScore, 100)

    const empUUID = uuidByEmpCode.get(emp.emp_code) ?? emp.emp_code
    const profile = profileByEmpCode.get(emp.emp_code)
    candidates.push({
      id: empUUID,
      empCode: emp.emp_code,
      name: emp.name,
      grade: emp.designation ?? '',
      serviceLine: emp.department ?? '',
      subServiceLine: emp.sub_function ?? '',
      location: emp.location ?? '',
      region: emp.region ?? '',
      primarySkill: empSkill,
      yearsExperience: profile?.yearsExperience ?? null,
      certifications: profile?.certifications ?? null,
      languages: profile?.languages ?? null,
      employeeNote: noteByUUID.get(empUUID) ?? null,
      utilization: util,
      fitScore,
      matchBreakdown: { skill: skillScore, availability: availScore, grade: gradeScore },
    })
  }

  candidates.sort((a, b) => b.fitScore - a.fitScore || a.utilization - b.utilization)

  res.json({ candidates, fromISO, toISO })
}))
