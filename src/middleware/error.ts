/**
 * Express equivalent of the old withErrorHandling + ok/fail helpers.
 */

import { ErrorRequestHandler, Request, Response, NextFunction } from 'express'

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('[api error]', err)
  const message = err instanceof Error ? err.message : 'Internal server error'
  res.status(500).json({ error: message })
}

/**
 * Wrap an async handler so thrown errors flow to errorHandler.
 * Removes the need for try/catch in every route.
 */
export function asyncHandler<R extends Request = Request>(
  fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: R, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/** Express-friendly alternatives to the Next.js ok/fail helpers. */
export function parseISODate(val: string | undefined | null): string | null {
  if (!val) return null
  const d = new Date(val)
  if (isNaN(d.getTime())) return null
  return d.toISOString().split('T')[0]
}

export function parseInt32(val: string | undefined | null, fallback: number): number {
  if (!val) return fallback
  const n = parseInt(val, 10)
  return isNaN(n) ? fallback : n
}
