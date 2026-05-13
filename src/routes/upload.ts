/**
 * POST /api/upload — ported from app/api/upload/route.ts.
 * Uses multer for multipart/form-data instead of Next's native FormData.
 */

import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import { ingestExcelFile } from '../services/ingestion/ingest'
import { parseMonthString } from '../services/ingestion/parse-excel'
import { ingestForecastFile } from '../services/ingestion/ingest-forecast'
import { isForecastTracker } from '../services/ingestion/parse-forecast'
import { ingestSkillMappingFile } from '../services/ingestion/ingest-skill-mapping'
import { isSkillMapping } from '../services/ingestion/parse-skill-mapping'
import { ingestRmsFile, isRmsFile } from '../services/ingestion/ingest-rms'
import { trackFileUpload } from '../services/file-versioning'
import { logAudit } from '../services/audit'
import { asyncHandler } from '../middleware/error'
import type { AuthedRequest } from '../middleware/auth'

const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
})

export const uploadRouter = Router()

uploadRouter.post('/', upload.single('file'), asyncHandler(async (req: AuthedRequest, res) => {
  const file = req.file
  const uploaderName = req.user?.name ?? 'System'

  if (!file) return res.status(400).json({ error: 'No file provided' })

  const ext = '.' + file.originalname.split('.').pop()?.toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ error: `Invalid file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}` })
  }

  if (file.size > MAX_FILE_SIZE) {
    return res.status(400).json({ error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: 10 MB` })
  }

  let periodOverride: { month: string; year: number } | undefined
  const periodStr = req.body?.period as string | undefined
  if (periodStr) {
    const pm = parseMonthString(periodStr)
    if (!pm) {
      return res.status(400).json({ error: `Invalid period format "${periodStr}". Use e.g. "Mar'2026" or "2026-03"` })
    }
    const [y, m] = pm.periodStart.split('-')
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    periodOverride = { month: monthNames[parseInt(m) - 1], year: parseInt(y) }
  }

  const buffer = file.buffer.buffer.slice(
    file.buffer.byteOffset,
    file.buffer.byteOffset + file.buffer.byteLength,
  ) as ArrayBuffer

  const workbook = XLSX.read(buffer, { type: 'array' })
  let isForecast = false
  let isSkillMap = false
  let isRms = false
  for (const sn of workbook.SheetNames) {
    const s = workbook.Sheets[sn]
    const row = (XLSX.utils.sheet_to_json(s, { header: 1 }) as unknown[][])[0] ?? []
    if (isSkillMapping(row)) { isSkillMap = true; break }
    if (isForecastTracker(row)) { isForecast = true; break }
    if (isRmsFile(row)) { isRms = true; break }
  }

  const fileName = file.originalname

  if (isRms) {
    const result = await ingestRmsFile(buffer, fileName)
    const status = result.errorCount === result.totalRows && result.totalRows > 0 ? 422 : 200

    trackFileUpload({
      fileName,
      fileType: 'rms',
      fileSize: file.size,
      uploadLogId: result.uploadId,
    }).catch(err => console.error('[upload] version tracking error:', err))

    logAudit({
      action: 'Created',
      entity: 'Employee',
      entityName: fileName,
      entityId: result.uploadId,
      userName: uploaderName,
      field: 'file_import',
      newValue: `Imported ${result.successCount}/${result.totalRows} rows`,
      metadata: {
        fileName,
        fileType: 'rms',
        fileSize: file.size,
        totalRows: result.totalRows,
        successCount: result.successCount,
        errorCount: result.errorCount,
        duration: result.duration,
      },
    }).catch(() => {})

    return res.status(status).json(result)
  }

  if (isSkillMap) {
    const result = await ingestSkillMappingFile(buffer, fileName)
    const status = result.errorCount === result.totalRows && result.totalRows > 0 ? 422 : 200

    trackFileUpload({
      fileName,
      fileType: 'skill_mapping',
      fileSize: file.size,
      uploadLogId: result.uploadId,
    }).catch(err => console.error('[upload] version tracking error:', err))

    logAudit({
      action: 'Created',
      entity: 'Employee',
      entityName: fileName,
      entityId: result.uploadId,
      userName: uploaderName,
      field: 'file_import',
      newValue: `Imported ${result.successCount}/${result.totalRows} rows`,
      metadata: {
        fileName,
        fileType: 'skill_mapping',
        fileSize: file.size,
        totalRows: result.totalRows,
        successCount: result.successCount,
        errorCount: result.errorCount,
        duration: result.duration,
      },
    }).catch(() => {})

    return res.status(status).json(result)
  }

  if (isForecast) {
    const result = await ingestForecastFile(buffer, fileName)
    const status = result.errorCount === result.totalRows && result.totalRows > 0 ? 422 : 200

    trackFileUpload({
      fileName,
      fileType: 'forecast_tracker',
      fileSize: file.size,
      uploadLogId: result.uploadId,
    }).catch(err => console.error('[upload] version tracking error:', err))

    logAudit({
      action: 'Created',
      entity: 'Allocation',
      entityName: fileName,
      entityId: result.uploadId,
      userName: uploaderName,
      field: 'file_import',
      newValue: `Imported ${result.successCount}/${result.totalRows} rows`,
      metadata: {
        fileName,
        fileType: 'forecast_tracker',
        fileSize: file.size,
        totalRows: result.totalRows,
        successCount: result.successCount,
        errorCount: result.errorCount,
        duration: result.duration,
      },
    }).catch(() => {})

    return res.status(status).json(result)
  }

  const result = await ingestExcelFile(buffer, fileName, undefined, periodOverride)
  const status = result.errorCount === result.totalRows && result.totalRows > 0 ? 422 : 200

  trackFileUpload({
    fileName,
    fileType: result.fileType ?? 'timesheet_compliance',
    fileSize: file.size,
    uploadLogId: result.uploadId,
  }).catch(err => console.error('[upload] version tracking error:', err))

  logAudit({
    action: 'Created',
    entity: 'Allocation',
    entityName: fileName,
    entityId: result.uploadId,
    userName: uploaderName,
    field: 'file_import',
    newValue: `Imported ${result.successCount}/${result.totalRows} rows`,
    metadata: {
      fileName,
      fileType: result.fileType ?? 'timesheet_compliance',
      fileSize: file.size,
      totalRows: result.totalRows,
      successCount: result.successCount,
      errorCount: result.errorCount,
      duration: result.duration,
    },
  }).catch(() => {})

  res.status(status).json(result)
}))
