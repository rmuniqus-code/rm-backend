/**
 * Excel Parsing & Validation Utilities
 *
 * Handles:
 * 1. Reading Excel/CSV files via xlsx
 * 2. Column header normalization
 * 3. Row-level data validation
 * 4. Date serial conversion (Excel stores dates as numbers)
 */

import * as XLSX from 'xlsx'
import { COLUMN_ALIASES } from './field-mapping'

// ─── Types ───────────────────────────────────────────────────

export interface ParsedRow {
  rowIndex: number
  data: Record<string, unknown>
}

export interface ValidationError {
  row: number
  field: string
  value: unknown
  message: string
}

export interface ParseResult {
  rows: ParsedRow[]
  headers: string[]
  errors: ValidationError[]
  sheetName: string
  totalRows: number
}

// ─── Excel Date Conversion ───────────────────────────────────
// Excel stores dates as serial numbers from 1900-01-01
// e.g. 44880 = 2022-11-14

export function excelDateToISO(serial: number | string): string | null {
  if (typeof serial === 'string') {
    // Already a date string — validate and return
    const d = new Date(serial)
    if (!isNaN(d.getTime())) {
      // Use local date parts to avoid UTC timezone shift
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${dd}`
    }
    return null
  }
  if (typeof serial !== 'number' || serial <= 0) return null
  // Excel epoch: Jan 1, 1900 (with the Lotus 1-2-3 leap year bug)
  const epoch = new Date(1899, 11, 30) // Dec 30, 1899
  const d = new Date(epoch.getTime() + serial * 86400000)
  // Use local date parts to avoid UTC timezone shift on toISOString()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

// ─── Month String Parsing ────────────────────────────────────
// "Feb'26" → { month: 'Feb', year: 2026, periodStart: '2026-02-01', periodEnd: '2026-02-28' }

export function parseMonthString(month: string): {
  label: string
  periodStart: string
  periodEnd: string
} | null {
  if (!month) return null
  // Match patterns like "Feb'26", "Mar'2026", "March 2026", "2026-03"
  const patterns = [
    /^([A-Za-z]+)'(\d{2})$/,          // Feb'26
    /^([A-Za-z]+)'(\d{4})$/,          // Feb'2026
    /^([A-Za-z]+)\s+(\d{4})$/,        // February 2026
    /^(\d{4})-(\d{2})$/,              // 2026-02
  ]

  const monthNames: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  }

  for (const pat of patterns) {
    const m = month.match(pat)
    if (!m) continue

    let monthIdx: number
    let year: number

    if (pat === patterns[3]) {
      // YYYY-MM format
      year = parseInt(m[1])
      monthIdx = parseInt(m[2]) - 1
    } else {
      const monthStr = m[1].toLowerCase()
      monthIdx = monthNames[monthStr]
      if (monthIdx === undefined) continue
      year = parseInt(m[2])
      if (year < 100) year += 2000
    }

    const start = new Date(year, monthIdx, 1)
    const end = new Date(year, monthIdx + 1, 0) // last day of month

    return {
      label: `${start.toLocaleString('en', { month: 'short' })}-${year}`,
      periodStart: start.toISOString().split('T')[0],
      periodEnd: end.toISOString().split('T')[0],
    }
  }
  return null
}

// ─── Header Normalization ────────────────────────────────────

function normalizeHeader(header: string): string {
  const trimmed = header.trim()
  return COLUMN_ALIASES[trimmed] || trimmed
}

// ─── Parse Excel Buffer ──────────────────────────────────────

export function parseExcelBuffer(
  buffer: ArrayBuffer,
  options?: { sheetIndex?: number }
): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheetName = workbook.SheetNames[options?.sheetIndex ?? 0]
  const sheet = workbook.Sheets[sheetName]
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 })

  if (raw.length < 2) {
    return { rows: [], headers: [], errors: [{ row: 0, field: '', value: '', message: 'File has no data rows' }], sheetName, totalRows: 0 }
  }

  // Normalize headers
  const rawHeaders = (raw[0] as string[]).map(h => normalizeHeader(String(h ?? '')))
  const headers = rawHeaders.filter(h => h.length > 0)

  const rows: ParsedRow[] = []
  const errors: ValidationError[] = []

  for (let i = 1; i < raw.length; i++) {
    const rawRow = raw[i] as unknown[]
    if (!rawRow || rawRow.length === 0) continue

    const data: Record<string, unknown> = {}
    let hasData = false

    for (let c = 0; c < rawHeaders.length; c++) {
      const key = rawHeaders[c]
      if (!key) continue
      let val = rawRow[c]
      if (val !== undefined && val !== null && val !== '') hasData = true
      data[key] = val ?? null
    }

    // Skip summary/empty rows
    if (!hasData) continue
    const deptName = String(data['Department Name'] ?? '')
    if (deptName.includes('Summary') || deptName.includes('Grand')) continue

    // Basic row validation
    const empId = data['Employee ID']
    if (!empId) {
      errors.push({ row: i + 1, field: 'Employee ID', value: empId, message: 'Missing Employee ID' })
      continue
    }

    const empName = data['Employee Name']
    if (!empName) {
      errors.push({ row: i + 1, field: 'Employee Name', value: empName, message: 'Missing Employee Name' })
      continue
    }

    // Convert dates
    if (data['Date of Joining']) {
      data['Date of Joining'] = excelDateToISO(data['Date of Joining'] as number)
    }
    if (data['Date of Exit'] && data['Date of Exit'] !== '') {
      data['Date of Exit'] = excelDateToISO(data['Date of Exit'] as number)
    } else {
      data['Date of Exit'] = null
    }

    // Ensure numeric fields default to 0
    const numericFields = [
      'Holidays (Days)', 'Leaves (Days)', 'Available Hours',
      'Chargeable', 'Non-Chargeable', 'Total Hours ',
      'Chargeability %', 'Compliance %',
    ]
    for (const f of numericFields) {
      const v = data[f]
      data[f] = typeof v === 'number' ? v : parseFloat(String(v)) || 0
    }

    rows.push({ rowIndex: i + 1, data })
  }

  return { rows, headers, errors, sheetName, totalRows: rows.length }
}

// ─── Detect File Type ────────────────────────────────────────

export type FileType = 'timesheet_compliance' | 'regionwise' | 'unknown'

export function detectFileType(headers: string[]): FileType {
  const headerSet = new Set(headers)
  if (headerSet.has('Month') && headerSet.has('Region') && headerSet.has('Employee Region')) {
    return 'regionwise'
  }
  if (headerSet.has('Employee ID') && headerSet.has('Chargeability %') && headerSet.has('Compliance %')) {
    return 'timesheet_compliance'
  }
  return 'unknown'
}
