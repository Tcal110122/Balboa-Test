// Runs a manager package from disk through the same intake pipeline
// the mailbox uses. Handy for backfilling old packages or testing a
// new manager's format.
//
//   node scripts/ingest-local-package.mjs "Ascend RVA -- 09.2026.zip"            # dry run: parse only
//   node scripts/ingest-local-package.mjs "Ascend RVA -- 09.2026.zip" --write    # store in Supabase
//
// --write needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.

import fs from 'node:fs'
import path from 'node:path'
import { expandAttachments, parsePackage, ingestPackage, adminClient, loadAliases } from '../lib/packages/intake.js'

const [file, flag] = process.argv.slice(2)
if (!file) {
  console.error('Usage: node scripts/ingest-local-package.mjs <package.zip|file> [--write]')
  process.exit(1)
}

const files = await expandAttachments([{ name: path.basename(file), buffer: fs.readFileSync(file) }])
console.log(`${files.length} files`)

if (flag !== '--write') {
  const parsed = parsePackage(files)
  if (!parsed) {
    console.log('No parser recognizes this package.')
    process.exit(0)
  }
  console.log({
    format: parsed.format, period: parsed.period, property: parsed.propertyNames,
    accounts: parsed.budgetVsActual.length, history_rows: parsed.t12.length,
    transactions: parsed.glDetail.length, balance_sheet: parsed.balanceSheet.length,
    beds: parsed.beds.length, warnings: parsed.warnings,
  })
  process.exit(0)
}

const db = adminClient()
const result = await ingestPackage(db, {
  files,
  message: { id: null, subject: path.basename(file) },
  aliases: await loadAliases(db),
})
console.log(JSON.stringify(result, null, 2))
