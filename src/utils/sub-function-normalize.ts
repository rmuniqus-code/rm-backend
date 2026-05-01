/**
 * Normalizes sub-function names so that ARC-US employees are merged into ARC-A.
 * Handles all common spacing/punctuation variants (e.g. "ARC - US", "ARC-US", "ARC US").
 */
export function normalizeSubFunction(name: string | null | undefined): string {
  if (!name) return name ?? ''
  if (/^arc[\s-]*us$/i.test(name.trim())) return 'ARC - A'
  return name
}

/**
 * Departments and sub-functions that should be completely excluded from the tool.
 * Central is a leadership/admin service line that must not appear in any UI, filter,
 * chart, or KPI. Its only sub-service line "LT" is excluded by the same rule.
 */
export const EXCLUDED_DEPARTMENTS = new Set(['Central', 'central'])
export const EXCLUDED_SUB_FUNCTIONS = new Set(['LT'])

/** Returns true when the row belongs to an excluded department or sub-function. */
export function isExcluded(dept: string | null | undefined, sub?: string | null | undefined): boolean {
  if (dept && EXCLUDED_DEPARTMENTS.has(dept)) return true
  if (sub && EXCLUDED_SUB_FUNCTIONS.has(sub)) return true
  return false
}
