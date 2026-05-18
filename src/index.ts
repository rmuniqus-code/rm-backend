/**
 * Express bootstrap.
 * Mounts every route under /api, guarded by requireAuth (except /healthz).
 */

import 'dotenv/config'
import express from 'express'
import cors from 'cors'

import { errorHandler } from './middleware/error'
import { requireAuth } from './middleware/auth'

import { allocationsRouter } from './routes/allocations'
import { employeesRouter } from './routes/employees'
import { auditLogRouter } from './routes/audit-log'
import { bookingsRouter } from './routes/bookings'
import { dashboardDataRouter } from './routes/dashboard-data'
import { exportsRouter } from './routes/exports'
import { fileUploadsRouter } from './routes/file-uploads'
import { findAvailabilityRouter } from './routes/find-availability'
import { notificationsRouter } from './routes/notifications'
import { outliersRouter } from './routes/outliers'
import { overAllocationRouter } from './routes/over-allocation'
import { projectsRouter } from './routes/projects'
import { resetDbRouter } from './routes/reset-db'
import { resourceRequestsRouter } from './routes/resource-requests'
import { resourcesDataRouter } from './routes/resources-data'
import { smartAllocateRouter } from './routes/smart-allocate'
import { uploadRouter } from './routes/upload'
import { utilizationRouter } from './routes/utilization'
import { authRouter, adminRouter } from './routes/auth'
import { forecastSummaryRouter } from './routes/forecast-summary'

const app = express()
const PORT = Number(process.env.PORT ?? 5000)

const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? 'http://localhost:4000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(express.json({ limit: '25mb' }))

app.get('/healthz', (_req, res) => {
  res.json({ ok: true })
})

// Public routes — no auth required
app.use('/auth', authRouter)

// All /api/* routes require a verified Supabase access token.
app.use('/api', requireAuth)

app.use('/api/allocations', allocationsRouter)
app.use('/api/employees', employeesRouter)
app.use('/api/audit-log', auditLogRouter)
app.use('/api/bookings', bookingsRouter)
app.use('/api/dashboard-data', dashboardDataRouter)
app.use('/api/exports', exportsRouter)
app.use('/api/file-uploads', fileUploadsRouter)
app.use('/api/find-availability', findAvailabilityRouter)
app.use('/api/notifications', notificationsRouter)
app.use('/api/outliers', outliersRouter)
app.use('/api/over-allocation', overAllocationRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/reset-db', resetDbRouter)
app.use('/api/resource-requests', resourceRequestsRouter)
app.use('/api/resources-data', resourcesDataRouter)
app.use('/api/smart-allocate', smartAllocateRouter)
app.use('/api/upload', uploadRouter)
app.use('/api/utilization', utilizationRouter)
app.use('/api/admin', adminRouter)
app.use('/api/forecast-summary', forecastSummaryRouter)

app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT}`)
  console.log(`[api] CORS origins: ${allowedOrigins.join(', ')}`)
})
