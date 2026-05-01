/**
 * Forecast Tracker Excel Parser
 *
 * Handles the unique structure of the Forecast Tracker workbook:
 *   - Columns 0-16:  Employee master data + utilization metrics
 *   - Columns 17-100: Weekly forecast (date headers = week-start Mondays)
 *
 * Key challenges:
 *   1. Merged cells span multiple weeks (one allocation over many columns)
 *   2. Weekly columns are sparse — NaN means "carry forward current project"
 *   3. Allocation text contains embedded percentages: "Task US-50%/ MAF-50%"
 *   4. Free-text project names with EM/EP embedded: "Hikma COE - EP - Vishal"
 */

import * as XLSX from 'xlsx'
import { FORECAST_MASTER_COLUMNS } from './field-mapping'
import { excelDateToISO } from './parse-excel'
import { safeISODate, toMonday } from '../../utils/date-utils'

// ─── Types ───────────────────────────────────────────────────

export interface ForecastEmployee {
  employeeId: string
  name: string
  email: string | null
  doj: string | null                    // ISO date
  location: string | null
  grade: string | null
  subTeam: string | null
  ftCore: string | null
  workMode: string | null               // Onsite/Remote/Secondment
  rocketlane: string | null
  currentProjectName: string | null
  currentEmEp: string | null
  projectType: string | null
  mtdUtilization: number | null
  wtdUtilization: number | null
  ytdUtilization: number | null
  comments: string | null
}

export interface AllocationEntry {
  projectName: string | null            // NULL for Available/Leave/etc.
  allocationPct: number                 // 0-100
  status: AllocationStatus
  rawText: string
}

export type AllocationStatus =
  | 'confirmed'
  | 'proposed'
  | 'available'
  | 'leave'
  | 'jip'
  | 'maternity'
  | 'unconfirmed'
  | 'leaver'

export interface WeeklyAllocation {
  weekStart: string                     // ISO date (Monday)
  allocations: AllocationEntry[]
}

export interface ForecastRow {
  rowIndex: number
  employee: ForecastEmployee
  weeklyAllocations: WeeklyAllocation[]
}

export interface ForecastParseResult {
  rows: ForecastRow[]
  weekColumns: string[]                 // ISO dates for all weekly columns
  errors: Array<{ row: number; field: string; message: string }>
  totalRows: number
}

// ─── Date Detection ──────────────────────────────────────────

/**
 * Check if a column header is a date (weekly forecast column).
 * Headers can be Excel serial dates, JS Date objects, or date strings.
 */
/**
 * Snap a Date to the nearest Monday.
 *
 * XLSX with `cellDates: true` often returns dates with timezone offsets that
 * shift the value by ±1 day (e.g. Monday June 9 becomes Sunday June 8
 * when the workbook was saved in IST but parsed in UTC).  Since forecast
 * columns are always week-start Mondays, snapping to the nearest Monday
 * corrects this drift without breaking correctly-parsed dates.
 */
function snapToMonday(d: Date): Date {
  const day = d.getDay() // 0=Sun … 6=Sat
  if (day === 1) return d // already Monday
  // Sun(0)→+1, Tue(2)→-1, Wed(3)→-2, Thu(4)→-3, Fri(5)→+3, Sat(6)→+2
  const offsets = [1, 0, -1, -2, -3, 3, 2]
  const snapped = new Date(d)
  snapped.setDate(snapped.getDate() + offsets[day])
  return snapped
}

function parseWeekDate(header: unknown): string | null {
  if (header == null || header === '') return null

  // Excel serial number (e.g. 45986 = 2025-12-08)
  if (typeof header === 'number' && header > 40000 && header < 60000) {
    const iso = excelDateToISO(header)
    if (!iso) return null
    return toMonday(iso)   // safeISODate + local-midnight parse inside toMonday
  }

  // Already a Date object (cellDates: true).
  // XLSX often returns UTC midnight which shifts ±1 day in UTC+ zones.
  // snapToMonday corrects the shift; safeISODate uses local time parts.
  if (header instanceof Date) {
    const year = header.getFullYear()
    if (year >= 2024 && year <= 2035) {
      return safeISODate(snapToMonday(header))
    }
    return null
  }

  // Handle "DD-Mon-YY" / "D-Mon-YYYY" (e.g. "15-Dec-25", "1-Jan-2026")
  // new Date("15-Dec-25") returns Invalid Date in JS — parse manually.
  if (typeof header === 'string') {
    const ddMonYY = header.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{2,4})$/)
    if (ddMonYY) {
      const MON: Record<string, number> = {
        jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11,
      }
      const mo = MON[ddMonYY[2].toLowerCase().slice(0, 3)]
      if (mo !== undefined) {
        let yr = parseInt(ddMonYY[3])
        if (yr < 100) yr += 2000
        if (yr >= 2024 && yr <= 2035) {
          // new Date(y, m, d) is local time — safe, no UTC shift
          return safeISODate(snapToMonday(new Date(yr, mo, parseInt(ddMonYY[1]))))
        }
      }
    }
  }

  // Generic string that looks like a date (e.g. "2025-06-09", "Jun 9 2025")
  if (typeof header === 'string') {
    const d = new Date(header)
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear()
      if (year >= 2024 && year <= 2035) {
        return safeISODate(snapToMonday(d))
      }
    }
  }

  return null
}

// ─── Allocation Text Parsing ─────────────────────────────────

const STATUS_KEYWORDS: Record<string, AllocationStatus> = {
  'available':    'available',
  'avaialble':    'available',    // common typo in source
  'leave':        'leave',
  'leaves':       'leave',
  'levaes':       'leave',        // common typo
  'jip':          'jip',
  'maternity':    'maternity',
  'leaver':       'leaver',
  'proposed':     'proposed',
  'propsoed':     'proposed',     // common typo
  'unconfirmed':  'unconfirmed',
}

/**
 * Lowercase tokens that appear in the "Employee ID" column when a real ID has
 * not yet been assigned (typically pending joiners).  Combined with
 * STATUS_KEYWORDS, these are the values we synthesize a Name+DOJ key for
 * instead of using verbatim — see buildPendingEmployeeId.
 */
export const PLACEHOLDER_IDS = new Set(['jip', 'tbc', 'tbd', 'tba', 'na', 'n/a'])

/** Prefix used for synthesized IDs of pending joiners (Employee ID == "JIP"). */
export const PENDING_EMP_ID_PREFIX = 'PENDING'

/**
 * Build a stable synthetic Employee ID for a pending joiner from their
 * Resource Name and DOJ.  The format is `PENDING-<slugified-name>-<YYYY-MM-DD>`,
 * deterministic across re-uploads as long as both inputs stay constant.  The
 * ingest layer reconciles a synthetic record into a real-ID record by
 * matching (name, DOJ) when the real ID first appears in a later upload.
 *
 * Returns null if either name or DOJ is empty — without DOJ we cannot tell
 * two different joiners with the same name apart, so the row should be
 * rejected rather than collapsed.
 */
export function buildPendingEmployeeId(name: string, doj: string | null): string | null {
  if (!doj) return null
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  if (!slug) return null
  return `${PENDING_EMP_ID_PREFIX}-${slug}-${doj}`
}

/**
 * Parse free-text allocation cell into structured entries.
 *
 * Examples:
 *   "Hikma COE - EP - Vishal Kuthia"        → [{ project: "Hikma COE", pct: 100, status: confirmed }]
 *   "Task US-50%/ MAF-50%"                  → [{ project: "Task US", pct: 50 }, { project: "MAF", pct: 50 }]
 *   "Amazon 50%- Namrata/ Available 50%"    → [{ project: "Amazon", pct: 50 }, { status: available, pct: 50 }]
 *   "Proposed for Hikma"                    → [{ project: "Hikma", pct: 100, status: proposed }]
 *   "Available"                             → [{ status: available, pct: 100 }]
 */
export function parseAllocationText(text: string): AllocationEntry[] {
  if (!text || text.trim() === '') return []

  const trimmed = text.trim()

  // Reject pure numeric strings (e.g. "0.79", "100") — these are raw Excel
  // percentage fractions or formula results that slipped into an allocation cell.
  // They are not valid allocation text and must never become project names.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return []

  // Check for pure status keyword
  const lowerTrimmed = trimmed.toLowerCase()
  for (const [keyword, status] of Object.entries(STATUS_KEYWORDS)) {
    if (lowerTrimmed === keyword) {
      return [{ projectName: null, allocationPct: 100, status, rawText: trimmed }]
    }
  }

  // Check for "Proposed for <project>" (whole text)
  const proposedMatch = trimmed.match(/^proposed\s+(?:for\s+)?(.+)$/i)
  if (proposedMatch) {
    const rest = proposedMatch[1]
    const pctM = rest.match(/(\d+)\s*%/)
    const pct = pctM ? parseInt(pctM[1]) : 100
    const projPart = pctM ? rest.substring(0, rest.indexOf(pctM[0])).trim() : rest
    return [{
      projectName: cleanProjectName(stripPersonSuffix(projPart)),
      allocationPct: pct,
      status: 'proposed',
      rawText: trimmed,
    }]
  }

  // Tentatively split on "/", ";", or newlines ONLY.
  // Do NOT split on " & " — it appears inside project names like "AST & Science".
  // The shouldSplit guard below prevents false splits on person-name suffixes
  // (e.g. "STC Bank - Sharukh / Saurav") where neither fragment has a %.
  const tentativeSegments = trimmed
    .split(/\s*[\/;\n]\s*/)
    .map(s => s.trim())
    .filter(Boolean)

  // Only treat "/", ";", or newlines as multi-allocation separators when EVERY
  // segment contains a %, matches a status keyword, or starts with "Proposed for".
  const looksLikeAllocation = (seg: string) => {
    if (/\d+\s*%/.test(seg)) return true
    const sl = seg.toLowerCase().trim()
    if (/^proposed\s/i.test(sl)) return true
    for (const keyword of Object.keys(STATUS_KEYWORDS)) {
      if (sl === keyword || sl.startsWith(keyword + ' ')) return true
    }
    return false
  }
  const shouldSplit = tentativeSegments.length > 1 && tentativeSegments.every(looksLikeAllocation)

  const segments = shouldSplit ? tentativeSegments : [trimmed]

  if (segments.length === 1) {
    const entry = parseSingleSegment(segments[0], trimmed)
    return isValidEntry(entry) ? [entry] : []
  }

  // Multiple segments — parse each, assign percentages
  const entries: AllocationEntry[] = []
  let totalPctAssigned = 0

  for (const seg of segments) {
    const entry = parseSingleSegment(seg, trimmed)
    entries.push(entry)
    totalPctAssigned += entry.allocationPct
  }

  // If no percentages were explicitly set (all defaulted to 100), split evenly
  const allDefault = entries.every(e => e.allocationPct === 100) && entries.length > 1
  if (allDefault) {
    const even = Math.round(100 / entries.length)
    entries.forEach(e => (e.allocationPct = even))
  }

  // Strip any phantom entries produced by malformed fragments
  return entries.filter(isValidEntry)
}

/**
 * Returns true if an AllocationEntry contains meaningful, storable data.
 *
 * Rejects:
 *   - Entries with 0, negative, or NaN allocation percentage
 *   - Confirmed/proposed/unconfirmed entries that have no project name
 *     (these would create ghost rows with a NULL project_id and a project status)
 */
function isValidEntry(e: AllocationEntry): boolean {
  if (!Number.isFinite(e.allocationPct) || e.allocationPct <= 0) return false
  if (
    (e.status === 'confirmed' || e.status === 'proposed' || e.status === 'unconfirmed') &&
    !e.projectName?.trim()
  ) return false
  return true
}

function parseSingleSegment(segment: string, fullText: string): AllocationEntry {
  const seg = segment.trim()

  // Extract percentage early (used by all branches)
  const pctMatch = seg.match(/(\d+)\s*%/)
  const pct = pctMatch ? parseInt(pctMatch[1]) : 100

  // Check for "Proposed for <project>" at segment level
  const proposedMatch = seg.match(/^proposed\s+(?:for\s+)?(.+)$/i)
  if (proposedMatch) {
    const rest = proposedMatch[1]
    const restPct = rest.match(/(\d+)\s*%/)
    const p = restPct ? parseInt(restPct[1]) : 100
    const projPart = restPct ? rest.substring(0, rest.indexOf(restPct[0])).trim() : rest
    return {
      projectName: cleanProjectName(stripPersonSuffix(projPart)),
      allocationPct: p,
      status: 'proposed',
      rawText: fullText,
    }
  }

  // Check if segment STARTS WITH a status keyword
  // This handles "Available confirm 20%", "Leave", "Leaves", etc.
  const segLower = seg.toLowerCase()
  for (const [keyword, status] of Object.entries(STATUS_KEYWORDS)) {
    if (segLower === keyword || segLower.startsWith(keyword + ' ') || segLower.startsWith(keyword + '%')) {
      return {
        projectName: null,
        allocationPct: pct,
        status,
        rawText: fullText,
      }
    }
  }

  // It's a project allocation — extract the project name
  let projectName: string

  if (pctMatch) {
    // Has percentage: project name is everything BEFORE the percentage digits.
    // "BASL 50%- Naveena" → before "50%" = "BASL "
    // "Centre 3 50%"      → before "50%" = "Centre 3 "
    const pctIndex = seg.indexOf(pctMatch[0])
    projectName = seg.substring(0, pctIndex).trim()
    // Also try: if projectName is empty, percentage may be at the start: "50%- Namrata"
    if (!projectName) {
      // Everything after the percentage marker
      const afterPct = seg.substring(pctIndex + pctMatch[0].length)
        .replace(/^\s*[\-–—]\s*/, '').trim()
      projectName = cleanProjectName(stripPersonSuffix(afterPct))
    }
  } else {
    // No percentage: strip trailing person name
    projectName = stripPersonSuffix(seg)
  }

  // Clean trailing dashes and apply project name cleaning
  projectName = projectName.replace(/[\-–—]\s*$/, '').trim()
  projectName = cleanProjectName(projectName)

  if (!projectName) {
    return { projectName: null, allocationPct: pct, status: 'available', rawText: fullText }
  }

  return {
    projectName,
    allocationPct: pct,
    status: 'confirmed',
    rawText: fullText,
  }
}

/**
 * Strip trailing person-name suffix from a segment.
 *
 * "BASL- Naveena"                         → "BASL"
 * "STC Bank - Sharukh Kapadia / Saurav Sen" → "STC Bank"
 * "Hikma COE - EP - Vishal Kuthia"        → "Hikma COE" (via cleanProjectName)
 * "Centre 3"                              → "Centre 3" (no change)
 */
function stripPersonSuffix(text: string): string {
  // First try the EP/EM pattern (most specific)
  let cleaned = text.replace(/\s*[\-–—]\s*(EP|EM)\s*[\-–—]\s*.+$/i, '').trim()
  // General pattern: dash (with at least a space after) followed by name(s) to end.
  // Requires space after dash so hyphenated project names like "Re-Design" are preserved.
  // Allows "/" in the person part for "Person1 / Person2".
  cleaned = cleaned.replace(/\s*[\-–—]\s+[A-Za-z][A-Za-z\s\/,.']*$/, '').trim()
  // Also handle no-space-before dash: "BASL- Naveena" (dash touching project, space before person)
  cleaned = cleaned.replace(/[\-–—]\s+[A-Za-z][A-Za-z\s\/,.']*$/, '').trim()
  // Remove trailing dashes
  cleaned = cleaned.replace(/[\-–—]\s*$/, '').trim()
  return cleaned || text.trim()
}

/**
 * Clean project name: strip "- EP -" suffixes, trim whitespace.
 * "Hikma COE - EP - Vishal Kuthia" → "Hikma COE"
 */
function cleanProjectName(name: string): string {
  // Remove " - EP - <name>" or " - EM - <name>" pattern
  let cleaned = name.replace(/\s*[\-–—]\s*(EP|EM)\s*[\-–—]\s*.+$/i, '').trim()
  // Remove trailing dashes
  cleaned = cleaned.replace(/[\-–—]\s*$/, '').trim()
  return cleaned || name.trim()
}

// ─── Main Parser ─────────────────────────────────────────────

export function parseForecastExcel(buffer: ArrayBuffer): ForecastParseResult {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })

  // Find the sheet that looks like a forecast tracker.
  // Some workbooks have summary / pivot sheets first; iterate all sheets and
  // pick the first one whose headers match forecast tracker expectations.
  let sheetName = workbook.SheetNames[0]
  for (const name of workbook.SheetNames) {
    const s = workbook.Sheets[name]
    const probe: unknown[][] = XLSX.utils.sheet_to_json(s, { header: 1, defval: null })
    if (probe.length >= 2 && isForecastTracker(probe[0] as unknown[])) {
      sheetName = name
      break
    }
  }
  const sheet = workbook.Sheets[sheetName]

  // Read raw data with header row
  const raw: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })

  if (raw.length < 2) {
    return {
      rows: [],
      weekColumns: [],
      errors: [{ row: 0, field: '', message: 'File has no data rows' }],
      totalRows: 0,
    }
  }

  // ── Step 1: Classify columns ──────────────────────────────

  const rawHeaders = raw[0] as unknown[]
  const weekColumnIndexes: Array<{ colIndex: number; weekDate: string }> = []
  const masterColumnMap: Record<string, number> = {}

  // Column indices for utilization metrics (matched by prefix)
  let mtdColIndex = -1
  let wcColIndex = -1
  let ytdColIndex = -1
  let commentsColIndex = -1

  for (let c = 0; c < rawHeaders.length; c++) {
    const h = rawHeaders[c]
    if (h == null || h === '') continue

    // Try to parse as a week date
    const weekDate = parseWeekDate(h)
    if (weekDate) {
      weekColumnIndexes.push({ colIndex: c, weekDate })
      continue
    }

    // String header — check master columns or utilization
    const headerStr = String(h).trim()

    if (FORECAST_MASTER_COLUMNS.has(headerStr)) {
      masterColumnMap[headerStr] = c
      continue
    }

    // Utilization columns have variable suffixes like "MTD 1-31 March"
    const headerLower = headerStr.toLowerCase()
    if (headerLower.startsWith('mtd')) { mtdColIndex = c; continue }
    if (headerLower.startsWith('wc') || headerLower.startsWith('w/c')) { wcColIndex = c; continue }
    if (headerLower.startsWith('ytd')) { ytdColIndex = c; continue }
    if (headerLower.startsWith('comment')) { commentsColIndex = c; continue }
  }

  const weekColumns = weekColumnIndexes.map(w => w.weekDate).sort()

  // Dev-mode: surface column layout so misalignment is immediately visible
  if (process.env.NODE_ENV !== 'production') {
    console.debug(
      '[parse-forecast] master columns:',
      Object.entries(masterColumnMap).map(([k, v]) => `${k}=col${v}`).join(' | '),
    )
    console.debug(
      '[parse-forecast] first 5 date columns:',
      weekColumnIndexes.slice(0, 5).map(w => `col${w.colIndex}→${w.weekDate}`).join(', '),
      `| total=${weekColumnIndexes.length}`,
    )
  }

  // ── Step 2: Expand merged cells ───────────────────────────
  // sheet_to_json returns null for non-origin cells inside a merge.
  // Build mergeValueMap so getCellValue can transparently return the origin's
  // value for any cell in the merge range.  Empty-origin merges are skipped —
  // their non-origin cells stay null and will be skipped by the allocation loop.

  const merges: XLSX.Range[] = sheet['!merges'] || []
  const mergeValueMap = new Map<string, unknown>()  // "row,col" → origin value

  // Lowest column index that is a weekly forecast column.
  // Vertical merges must NOT be expanded into weekly columns: doing so would
  // propagate one employee sub-row's project text down into adjacent sub-rows,
  // making every project appear in every row for the same employee (root cause
  // of phantom 1000%+ allocations in multi-row-per-employee sheets).
  const firstWeekCol = weekColumnIndexes.length > 0
    ? weekColumnIndexes.reduce((min, w) => Math.min(min, w.colIndex), Infinity)
    : Infinity

  for (const merge of merges) {
    const originCell = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })
    const originValue = sheet[originCell]?.v ?? null
    if (originValue == null) continue  // empty-origin merges have nothing to propagate

    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r === merge.s.r && c === merge.s.c) continue  // skip origin itself
        // Block vertical propagation into weekly columns (only master columns
        // like Employee ID / Name may propagate across rows)
        if (r !== merge.s.r && c >= firstWeekCol) continue
        mergeValueMap.set(`${r},${c}`, originValue)
      }
    }
  }

  /** Return the cell value, expanding merge origins transparently. */
  function getCellValue(rowIdx: number, colIdx: number): unknown {
    const rowData = raw[rowIdx]
    if (!rowData) return null
    const val = rowData[colIdx]
    if (val != null && val !== '') return val
    return mergeValueMap.get(`${rowIdx},${colIdx}`) ?? null
  }

  // ── Step 3: Parse each employee row ───────────────────────

  const rows: ForecastRow[] = []
  const errors: Array<{ row: number; field: string; message: string }> = []

  for (let i = 1; i < raw.length; i++) {
    const empIdCol = masterColumnMap['Employee ID']
    const nameCol = masterColumnMap['Resource Name']

    const empIdRaw = getCellValue(i, empIdCol)
    if (empIdRaw == null || String(empIdRaw).trim() === '') continue

    const nameRaw = getCellValue(i, nameCol)
    if (nameRaw == null || String(nameRaw).trim() === '') {
      errors.push({ row: i + 1, field: 'Resource Name', message: 'Missing name' })
      continue
    }

    // Parse DOJ early — needed to synthesize stable IDs for placeholder rows
    const dojRaw = getCellValue(i, masterColumnMap['DOJ'])
    let doj: string | null = null
    if (dojRaw instanceof Date) {
      doj = dojRaw.toISOString().split('T')[0]
    } else if (dojRaw != null) {
      doj = excelDateToISO(dojRaw as number) ?? null
    }

    // Skip JIP (Joining in Progress) resources — they have no real employee
    // record yet and should not appear in the resource manager.
    const empIdStr = String(empIdRaw).trim()
    const empIdLower = empIdStr.toLowerCase()
    if (empIdLower === 'jip') continue

    // Resolve other placeholder Employee IDs ("TBC", …) into a stable synthetic
    // key derived from Resource Name + DOJ.  Without this, every pending joiner
    // shares the literal string "TBC" as their Employee ID and the multi-row
    // merge key collapses them all onto one phantom record (the source of the
    // 1000% allocation bug).  When HR later assigns a real ID, the ingest layer
    // reconciles by matching name+DOJ and renames the synthetic record in place
    // — preserving the UUID and all forecast_allocations FK references to it.
    const isPlaceholderId =
      PLACEHOLDER_IDS.has(empIdLower) || empIdLower in STATUS_KEYWORDS
    let resolvedEmpId = empIdStr
    if (isPlaceholderId) {
      const synthetic = buildPendingEmployeeId(String(nameRaw).trim(), doj)
      if (!synthetic) {
        errors.push({
          row: i + 1,
          field: 'Employee ID',
          message: `Placeholder Employee ID "${empIdStr}" for "${nameRaw}" requires a DOJ to synthesize a stable key`,
        })
        continue
      }
      resolvedEmpId = synthetic
    }

    // Parse utilization metrics
    const mtdRaw = mtdColIndex >= 0 ? getCellValue(i, mtdColIndex) : null
    const wcRaw = wcColIndex >= 0 ? getCellValue(i, wcColIndex) : null
    const ytdRaw = ytdColIndex >= 0 ? getCellValue(i, ytdColIndex) : null
    const commentsRaw = commentsColIndex >= 0 ? getCellValue(i, commentsColIndex) : null

    // Strip placeholder values from the email column (JIP rows often have email="JIP")
    const emailRaw = safeStr(getCellValue(i, masterColumnMap['Email']))
    const email = emailRaw && (
      PLACEHOLDER_IDS.has(emailRaw.toLowerCase()) ||
      emailRaw.toLowerCase() in STATUS_KEYWORDS ||
      !emailRaw.includes('@')
    ) ? null : emailRaw

    const employee: ForecastEmployee = {
      employeeId: resolvedEmpId,
      name: String(nameRaw).trim(),
      email,
      doj,
      location: safeStr(getCellValue(i, masterColumnMap['Location'])),
      grade: safeStr(getCellValue(i, masterColumnMap['Resource Grade'])),
      subTeam: safeStr(getCellValue(i, masterColumnMap['Sub Team'])),
      ftCore: safeStr(getCellValue(i, masterColumnMap['FT Core'])),
      workMode: safeStr(getCellValue(i, masterColumnMap['Secondment/Onsite/Remote'])),
      rocketlane: safeStr(getCellValue(i, masterColumnMap['Rocketlane'])),
      currentProjectName: safeStr(getCellValue(i, masterColumnMap['Current Project Name'])),
      currentEmEp: safeStr(getCellValue(i, masterColumnMap['Current EM/EP'])),
      projectType: safeStr(getCellValue(i, masterColumnMap['Project Type'])),
      mtdUtilization: safeNum(mtdRaw),
      wtdUtilization: safeNum(wcRaw),
      ytdUtilization: safeNum(ytdRaw),
      comments: commentsRaw != null ? String(commentsRaw).trim() : null,
    }

    // ── Parse weekly allocations ───────────────────────────
    // Strict rule: a week is only stored when its cell has an EXPLICIT value
    // (either a direct value or one expanded from a merge origin by getCellValue).
    //
    // • Empty cells           → skipped — no defaults, no carry-forward
    // • Merge-covered cells   → getCellValue already returns the origin value,
    //                           so multi-week merged allocations are transparent
    // • Pure-numeric cells    → parseAllocationText returns [] → skipped
    // • Malformed fragments   → isValidEntry filter inside parseAllocationText
    //                           prevents ghost entries being stored

    const weeklyAllocations: WeeklyAllocation[] = []

    for (const { colIndex, weekDate } of weekColumnIndexes) {
      const cellVal = getCellValue(i, colIndex)

      // Skip null, undefined, and blank-string cells
      if (cellVal == null || String(cellVal).trim() === '') continue

      const rawStr = String(cellVal).trim()
      const allocations = parseAllocationText(rawStr)

      if (process.env.NODE_ENV !== 'production' && i <= 3) {
        console.debug(
          `[parse-forecast] row${i} week=${weekDate}`,
          `raw=${JSON.stringify(rawStr)}`,
          '→',
          allocations.length === 0
            ? '(skipped — invalid or numeric)'
            : allocations.map(a => `${a.projectName ?? a.status}(${a.allocationPct}%)`).join(' + '),
        )
      }

      // Skip cells that produced no valid entries (pure numbers, malformed text, etc.)
      if (allocations.length === 0) continue

      weeklyAllocations.push({ weekStart: weekDate, allocations })
    }

    // ── Post-process: fill implicit gaps within a same-project run ────────
    //
    // A merged Excel cell that spans weeks W1–W5 should make getCellValue
    // return the origin value for every column in that range.  In practice the
    // XLSX merge boundary occasionally does not align with every week column
    // header, leaving one or more columns null inside what is visually a single
    // continuous bar.
    //
    // Rule: if every empty week in a contiguous gap is flanked by the SAME
    // single project allocation (matching projectName + status) on both sides,
    // fill the gap with that allocation.
    //
    // Gaps that cross a genuine status change (e.g. DWTC → Available → DWTC)
    // are deliberately NOT filled — the flanking allocations differ.
    {
      const byWeek = new Map<string, AllocationEntry[]>()
      for (const wa of weeklyAllocations) byWeek.set(wa.weekStart, wa.allocations)

      let gapStart = -1

      for (let wi = 0; wi <= weekColumnIndexes.length; wi++) {
        const col     = weekColumnIndexes[wi]            // undefined past last index
        const hasData = col !== undefined && byWeek.has(col.weekDate)

        if (!hasData && gapStart === -1 && col !== undefined) {
          gapStart = wi                                   // open a new empty run

        } else if (hasData && gapStart !== -1) {          // empty run just closed

          const before = gapStart > 0
            ? byWeek.get(weekColumnIndexes[gapStart - 1].weekDate)
            : undefined
          const after = byWeek.get(col.weekDate)

          // Fill the gap when both flanking weeks carry identical allocations.
          // allocationsEqual handles any number of entries (single project,
          // dual-project like "BASL + Task US", status-only, …) and normalises
          // project names so minor whitespace/case differences don't break matches.
          //
          // Hard cap: only fill gaps ≤ 4 consecutive empty weeks.  Larger gaps
          // are intentionally absent, not merge-boundary artefacts.
          const gapSize = wi - gapStart
          if (before && after && allocationsEqual(before, after) && gapSize <= 4) {
            for (let gi = gapStart; gi < wi; gi++) {
              const wd = weekColumnIndexes[gi].weekDate
              // Deep-copy each entry so mutations downstream don't alias shared objects
              weeklyAllocations.push({ weekStart: wd, allocations: before.map(e => ({ ...e })) })
            }
          }

          gapStart = -1
        }
        // Trailing open gaps (no data after the gap) are intentionally not filled.
      }
    }

    // Multi-row-per-employee: if this Employee ID already has a row, merge
    // the weekly allocations into it rather than creating a duplicate.
    const existingRow = rows.find(r => r.employee.employeeId === employee.employeeId)
    if (existingRow) {
      existingRow.weeklyAllocations.push(...weeklyAllocations)
    } else {
      rows.push({ rowIndex: i + 1, employee, weeklyAllocations })
    }
  }

  return { rows, weekColumns, errors, totalRows: rows.length }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * True when two allocation lists represent the same assignment.
 *
 * Handles:
 *   - Any number of allocation entries (1 project, 2 projects, status-only, …)
 *   - Order-independent comparison (sorted by a canonical key before comparing)
 *   - Normalised project names: trimmed + lower-cased to absorb whitespace /
 *     capitalisation drift between cells in different weeks of the same merge
 *
 * Used by the gap-fill pass to decide whether an empty week sits inside a
 * continuous allocation run and should be backfilled.
 */
function allocationsEqual(a: AllocationEntry[], b: AllocationEntry[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false
  const key = (e: AllocationEntry) =>
    `${(e.projectName ?? '').trim().toLowerCase()}|${e.status}|${e.allocationPct}`
  const sortedA = a.map(key).sort()
  const sortedB = b.map(key).sort()
  return sortedA.every((k, idx) => k === sortedB[idx])
}

function safeStr(val: unknown): string | null {
  if (val == null || val === '') return null
  return String(val).trim() || null
}

function safeNum(val: unknown): number | null {
  if (val == null || val === '') return null
  const n = typeof val === 'number' ? val : parseFloat(String(val))
  return isNaN(n) ? null : n
}

// ─── Detect if file is a Forecast Tracker ────────────────────

export function isForecastTracker(headers: unknown[]): boolean {
  const headerStrs = headers
    .filter(h => h != null)
    .map(h => String(h).trim())

  const hasEmployeeId = headerStrs.some(h => h === 'Employee ID')
  const hasResourceName = headerStrs.some(h => h === 'Resource Name')
  const hasSubTeam = headerStrs.some(h => h === 'Sub Team')
  const hasDateColumns = headers.some(h => parseWeekDate(h) !== null)

  return hasEmployeeId && hasResourceName && hasSubTeam && hasDateColumns
}
