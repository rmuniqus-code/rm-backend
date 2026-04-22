/**
 * Skill Mapping Excel Parser
 *
 * Detects and parses "ARC GRC Skillmapping" workbooks.
 *
 * Expected columns (row 1 = headers):
 *   0  Email
 *   1  Employee ID
 *   2  Name
 *   3  Designation
 *   4  Location
 *   5  Primary Skillset ( Select any 1 )
 *   6  Secondary Skillset ( Select at most 2 )
 *   7  Tertiary Skillset ( Select at most 3 )
 *   8  Primary Sector of Work ( Select any one )
 *   9  Secondary Sector of Work (Can select multiple)
 */

import * as XLSX from 'xlsx'

// ─── Types ────────────────────────────────────────────────────

export interface SkillMappingRow {
  email: string
  employeeId: string
  name: string
  designation: string
  location: string
  primarySkill: string
  secondarySkills: string[]   // raw values from Secondary Skillset column
  tertiarySkills: string[]    // raw values from Tertiary Skillset column
  primarySector: string
  secondarySectors: string[]
}

// ─── Detection ───────────────────────────────────────────────

/**
 * Returns true when the header row belongs to the skill mapping sheet.
 * Checks for "Primary Skillset" in any header cell (case-insensitive).
 */
export function isSkillMapping(headers: unknown[]): boolean {
  return headers.some(
    h => typeof h === 'string' && h.toLowerCase().includes('primary skillset'),
  )
}

// ─── Helpers ─────────────────────────────────────────────────

/** Split a semicolon-delimited cell, trim, drop blanks and "Not Applicable". */
function splitCell(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(';')
    .map(s => s.trim())
    .filter(s => s && s !== 'Not Applicable')
}

// ─── Parser ──────────────────────────────────────────────────

export function parseSkillMappingExcel(buffer: ArrayBuffer): SkillMappingRow[] {
  const wb = XLSX.read(buffer, { type: 'array' })

  // Find the sheet that looks like a skill mapping
  let targetSheet: XLSX.WorkSheet | null = null
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
    if (rows.length > 0 && isSkillMapping(rows[0] as unknown[])) {
      targetSheet = ws
      break
    }
  }

  if (!targetSheet) return []

  const rows = XLSX.utils.sheet_to_json<string[]>(targetSheet, {
    header: 1,
    defval: '',
  }) as string[][]

  // Skip header row
  return rows.slice(1).flatMap(r => {
    const email      = String(r[0] ?? '').trim()
    const employeeId = String(r[1] ?? '').trim()

    // Drop completely empty rows
    if (!email && !employeeId) return []

    return [{
      email,
      employeeId,
      name:             String(r[2] ?? '').trim(),
      designation:      String(r[3] ?? '').trim(),
      location:         String(r[4] ?? '').trim(),
      primarySkill:     String(r[5] ?? '').trim(),
      secondarySkills:  splitCell(String(r[6] ?? '')),
      tertiarySkills:   splitCell(String(r[7] ?? '')),
      primarySector:    String(r[8] ?? '').trim(),
      secondarySectors: splitCell(String(r[9] ?? '')),
    }]
  })
}

// ─── Secondary skill dedup logic ─────────────────────────────

/**
 * Merge secondary + tertiary skill lists into a single ordered,
 * deduplicated list, excluding the primary skill.
 *
 * Returns [{skillName, order}] where order is 1-based rank.
 *   1 = first secondary, 2 = second secondary …
 *   tertiary-only entries continue the sequence after secondaries.
 *   Lower order = stronger signal.
 */
export function buildSecondarySkillList(
  primary: string,
  secondary: string[],
  tertiary: string[],
): { skillName: string; order: number }[] {
  const seen = new Set<string>([primary.trim()])
  const result: { skillName: string; order: number }[] = []
  let order = 1

  for (const skillName of [...secondary, ...tertiary]) {
    if (seen.has(skillName)) continue
    seen.add(skillName)
    result.push({ skillName, order })
    order++
  }

  return result
}
