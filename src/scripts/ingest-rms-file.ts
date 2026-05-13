/**
 * Direct RMS ingestion script.
 *
 * Usage (from rm-backend/ directory):
 *   npx tsx src/scripts/ingest-rms-file.ts "../../RMS - 22 Apr 2026.xlsx"
 *
 * Requires rm-backend/.env with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'

// Load .env before importing anything that needs Supabase credentials
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import { ingestRmsFile } from '../services/ingestion/ingest-rms'

async function main() {
  const filePath = process.argv[2] ?? path.resolve(__dirname, '../../../RMS - 22 Apr 2026.xlsx')
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`)
    process.exit(1)
  }

  console.log(`Reading: ${absPath}`)
  const buffer = fs.readFileSync(absPath).buffer

  console.log('Starting RMS ingestion…')
  const result = await ingestRmsFile(buffer, path.basename(absPath))

  console.log('\n── Result ─────────────────────────────')
  console.log(`File type : ${result.fileType}`)
  console.log(`Total rows: ${result.totalRows}`)
  console.log(`Succeeded : ${result.successCount}`)
  console.log(`Errors    : ${result.errorCount}`)
  console.log(`Duration  : ${result.duration}ms`)

  if (result.errors.length > 0) {
    console.log('\n── First 20 errors ────────────────────')
    result.errors.slice(0, 20).forEach(e => {
      console.log(`  Row ${e.row} [${e.field}] "${e.value}": ${e.message}`)
    })
  }

  if (result.errorCount === 0) {
    console.log('\n✓ All rows imported successfully.')
    console.log('\nNext step: Run rm-frontend/supabase/migrations/008_rms_fields.sql')
    console.log('           in the Supabase SQL Editor, then run this script again')
    console.log('           to populate employee_status and the other new fields.')
  }
  process.exit(result.errorCount === result.totalRows && result.totalRows > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
