/**
 * Canonical date helpers — single source of truth for week bucketing.
 *
 * Rules enforced here:
 *   1. Weeks start on Monday (ISO 8601).
 *   2. All date strings are YYYY-MM-DD in LOCAL time — never toISOString()
 *      which would convert to UTC and shift the date in UTC+ zones (IST etc.).
 *   3. "Parse a YYYY-MM-DD string" always appends T00:00:00 (no Z) so the
 *      date is interpreted in the local timezone, not UTC midnight.
 */

/**
 * Parse a YYYY-MM-DD string as LOCAL midnight.
 * `new Date("2025-06-09")` = UTC midnight, which in IST shifts to Jun 8.
 * `new Date("2025-06-09T00:00:00")` = local midnight — always correct.
 */
export function parseLocalDate(iso: string): Date {
  return new Date(iso + 'T00:00:00')
}

/**
 * Format a Date as YYYY-MM-DD using LOCAL time parts.
 * Never use d.toISOString().split('T')[0] — that uses UTC.
 */
export function safeISODate(d: Date): string {
  const y  = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

/**
 * Return the YYYY-MM-DD of the Monday for the week containing `iso`.
 *
 * This is the canonical bucketing function — use it everywhere instead
 * of inline getDay() arithmetic.
 *
 * Examples:
 *   toMonday("2025-06-09") → "2025-06-09"  (already Monday)
 *   toMonday("2025-06-08") → "2025-06-09"  (Sunday → next Monday)
 *   toMonday("2025-06-11") → "2025-06-09"  (Wednesday → previous Monday)
 */
export function toMonday(iso: string): string {
  const d   = parseLocalDate(iso)
  const day = d.getDay()                  // 0=Sun, 1=Mon … 6=Sat
  const diff = day === 0 ? -6 : 1 - day  // distance back to Monday (negative)
  d.setDate(d.getDate() + diff)
  return safeISODate(d)
}

/**
 * True if two YYYY-MM-DD strings land in the same ISO week (Mon–Sun).
 */
export function isSameWeek(a: string, b: string): boolean {
  return toMonday(a) === toMonday(b)
}

/**
 * Add N weeks to a YYYY-MM-DD string, returns YYYY-MM-DD (local time).
 */
export function addWeeksTo(iso: string, n: number): string {
  const d = parseLocalDate(iso)
  d.setDate(d.getDate() + n * 7)
  return safeISODate(d)
}
