/**
 * Seed script — loads the two Excel files into Supabase
 *
 * Usage:
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx supabase/seed.ts
 *
 * Prerequisites:
 *   - Run schema.sql against your Supabase project first
 *   - Place Excel files in Downloads or update paths below
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ingestExcelFile } from '../lib/ingestion/ingest'

const FILES = [
  {
    path: resolve(process.env.USERPROFILE || '', 'Downloads', 'Employee_Timesheet_Compliance_1-31_March.xlsx'),
    period: { month: 'Mar', year: 2026 },
  },
  {
    path: resolve(process.env.USERPROFILE || '', 'Downloads', 'Regionwise view.xlsx'),
    // Period is auto-detected from the "Month" column (Feb'26)
  },
]

async function main() {
  console.log('🚀 Starting seed...\n')

  for (const { path: filePath, period } of FILES) {
    const fileName = filePath.split(/[/\\]/).pop()!
    console.log(`📄 Processing: ${fileName}`)

    const buf = readFileSync(filePath)
    const buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

    const result = await ingestExcelFile(buffer as ArrayBuffer, fileName, undefined, period)

    console.log(`   Type:      ${result.fileType}`)
    console.log(`   Rows:      ${result.totalRows}`)
    console.log(`   Success:   ${result.successCount}`)
    console.log(`   Errors:    ${result.errorCount}`)
    console.log(`   Duration:  ${result.duration}ms`)
    if (result.errors.length > 0) {
      console.log(`   First 5 errors:`)
      result.errors.slice(0, 5).forEach(e => console.log(`     Row ${e.row}: [${e.field}] ${e.message}`))
    }
    console.log()
  }

  console.log('✅ Seed complete')
}

main().catch(err => {
  console.error('❌ Seed failed:', err)
  process.exit(1)
})
