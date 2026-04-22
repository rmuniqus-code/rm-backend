/**
 * Shared hours / loading / working-days calculations.
 *
 * Single source of truth used across:
 *   - Request creation & editing (raise-request-form)
 *   - Allocation modal (allocate-resource-modal)
 *   - Duration display (request tables)
 *   - Approve API (forecast allocation creation)
 *
 * Standard working day = 8 hours.
 */

export const STANDARD_HOURS_PER_DAY = 8

/**
 * Count weekdays (Mon–Fri) between two dates, inclusive.
 */
export function countWorkingDays(start: Date, end: Date): number {
  let count = 0
  const d = new Date(start)
  d.setHours(0, 0, 0, 0)
  const endNorm = new Date(end)
  endNorm.setHours(0, 0, 0, 0)
  while (d <= endNorm) {
    const day = d.getDay()
    if (day !== 0 && day !== 6) count++
    d.setDate(d.getDate() + 1)
  }
  return count
}

/**
 * Count weekdays from ISO date strings ("YYYY-MM-DD").
 * Returns 0 if either date is invalid.
 */
export function countWorkingDaysISO(startISO: string, endISO: string): number {
  if (!startISO || !endISO) return 0
  const s = new Date(startISO + 'T00:00:00')
  const e = new Date(endISO + 'T00:00:00')
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0
  return countWorkingDays(s, e)
}

/**
 * Convert loading % → hours per day.
 * 100% = 8h, 50% = 4h, 125% = 10h
 */
export function loadingToHoursPerDay(loadingPct: number): number {
  return round2((loadingPct / 100) * STANDARD_HOURS_PER_DAY)
}

/**
 * Convert hours per day → loading %.
 * 8h = 100%, 4h = 50%, 10h = 125%
 */
export function hoursPerDayToLoading(hpd: number): number {
  return Math.round((hpd / STANDARD_HOURS_PER_DAY) * 100)
}

/**
 * Compute total hours for a request.
 *   total = hoursPerDay × workingDays
 */
export function computeTotalHours(hoursPerDay: number, workingDays: number): number {
  return round2(hoursPerDay * workingDays)
}

/**
 * Derive hours per day from total hours and working days.
 */
export function totalHoursToPerDay(totalHours: number, workingDays: number): number {
  if (workingDays <= 0) return 0
  return round2(totalHours / workingDays)
}

/**
 * Parse a display hours string like "7h 59m" or "8h" → decimal hours.
 */
export function parseHoursString(str: string): number {
  if (!str) return STANDARD_HOURS_PER_DAY
  const hMatch = str.match(/(\d+)\s*h/)
  const mMatch = str.match(/(\d+)\s*m/)
  const h = hMatch ? parseInt(hMatch[1], 10) : 0
  const m = mMatch ? parseInt(mMatch[1], 10) : 0
  return h + m / 60
}

/**
 * Format decimal hours into a compact display string.
 *   8 → "8h"
 *   7.983 → "7h 59m"
 *   0 → "0h"
 */
export function formatHours(hours: number): string {
  if (hours <= 0) return '0h'
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/**
 * Format total hours for display as a clean label.
 *   40 → "40 hours"
 *   37.5 → "37.5 hours"
 */
export function formatTotalHours(total: number): string {
  if (total <= 0) return '0 hours'
  const rounded = round2(total)
  return `${rounded} hours`
}

/**
 * Parse a display date like "18 Nov 25" → ISO "2025-11-18".
 * Also accepts ISO format directly.
 */
export function parseDisplayDateToISO(display: string): string {
  if (!display) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(display)) return display
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  }
  const parts = display.trim().split(/\s+/)
  if (parts.length === 3) {
    const [day, mon, yr] = parts
    const month = months[mon] ?? '01'
    const year = yr.length === 2 ? `20${yr}` : yr
    return `${year}-${month}-${day.padStart(2, '0')}`
  }
  return ''
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
