// Turns an emailed manager package into stored files + parsed rows.
//
// Kept separate from the Graph client so it can run against a local
// zip (scripts/ingest-local-package.mjs) as well as live mail.

import crypto from 'node:crypto'
import JSZip from 'jszip'
import { createClient } from '@supabase/supabase-js'
import { parseCoastalRidgePackage } from './coastal-ridge.js'

export const BUCKET = 'manager-packages'

export function adminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}

const DEFAULT_DOMAINS = 'thebalboagroup.com,coastalridge.com,greystar.com,colliers.com,rpmliving.com,flco.com'

// Packages are accepted only from Balboa staff (forwards) and known managers.
export function isAllowedSender(address) {
  const domains = (process.env.INGEST_ALLOWED_DOMAINS || DEFAULT_DOMAINS).split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  const domain = String(address || '').toLowerCase().split('@')[1] || ''
  return domains.some(d => domain === d || domain.endsWith(`.${d}`))
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const MAX_FILES = 200
const MAX_TOTAL_BYTES = 150 * 1024 * 1024

// attachments: Array<{ name, contentType, buffer, isInline }>
// Returns a flat list of files; zips (and zips inside zips, one level) are expanded.
export async function expandAttachments(attachments) {
  const out = []
  let total = 0
  const push = (name, buffer, contentType) => {
    total += buffer.length
    if (out.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error('Package is larger than the intake limit')
    out.push({ name, buffer, contentType: contentType || null })
  }
  const unzip = async (zipName, buffer, depth) => {
    const zip = await JSZip.loadAsync(buffer)
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue
      const base = entry.name.split('/').pop()
      if (entry.name.startsWith('__MACOSX/') || base.startsWith('.') || base.startsWith('~$')) continue
      const buf = await entry.async('nodebuffer')
      const name = `${zipName.replace(/\.zip$/i, '')}/${entry.name}`
      if (/\.zip$/i.test(base) && depth < 1) await unzip(name, buf, depth + 1)
      else push(name, buf)
    }
  }
  for (const a of attachments) {
    if (a.isInline) continue // signature logos
    if (/\.zip$/i.test(a.name)) await unzip(a.name, a.buffer, 0)
    else push(a.name, a.buffer, a.contentType)
  }
  return out
}

// ---------------------------------------------------------------
// Matching a package to a deal and a month
// ---------------------------------------------------------------

export async function loadAliases(db) {
  const { data, error } = await db.from('deal_aliases').select('deal_id, alias')
  if (error) throw new Error(`deal_aliases: ${error.message}`)
  return (data || []).sort((a, b) => b.alias.length - a.alias.length)
}

// texts are checked in order of trust; within a text the longest alias wins.
export function matchDeal(texts, aliases) {
  for (const t of texts) {
    const hay = String(t || '').toLowerCase()
    const hit = aliases.find(a => hay.includes(a.alias.toLowerCase()))
    if (hit) return hit.deal_id
  }
  return null
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
export function guessPeriod(texts) {
  for (const t of texts) {
    const s = String(t || '').toLowerCase()
    let m = s.match(/\b(0?[1-9]|1[0-2])[./-](20\d\d)\b/) // 09.2026, 09/2026
    if (m) return `${m[2]}-${m[1].padStart(2, '0')}-01`
    m = s.match(/\b(20\d\d)-(0[1-9]|1[0-2])\b/) // 2026-09
    if (m) return `${m[1]}-${m[2]}-01`
    m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/)
    if (m) return `${m[2]}-${String(MONTH_NAMES.findIndex(n => n.startsWith(m[1])) + 1).padStart(2, '0')}-01`
  }
  return null
}

// ---------------------------------------------------------------
// Parser registry — first parser that recognizes the package wins
// ---------------------------------------------------------------

const PARSERS = [parseCoastalRidgePackage]

export function parsePackage(files) {
  for (const parse of PARSERS) {
    const result = parse(files)
    if (result) return result
  }
  return null
}

// ---------------------------------------------------------------
// Storing
// ---------------------------------------------------------------

async function insertChunks(db, table, rows, { upsert = false, onConflict } = {}) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const q = upsert ? db.from(table).upsert(chunk, { onConflict }) : db.from(table).insert(chunk)
    const { error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
  }
}

export async function storeParsed(db, { dealId, packageId, parsed }) {
  const period = parsed.period
  const stamp = { deal_id: dealId, package_id: packageId }

  // History from the T-12 first (actuals only, so budgets and notes already
  // stored for those months are left alone), then this month's full
  // budget-vs-actual on top.
  const t12 = parsed.t12.map(r => ({ ...stamp, ...r, updated_at: new Date().toISOString() }))
  await insertChunks(db, 'gl_monthly', t12, { upsert: true, onConflict: 'deal_id,period,account_code' })

  const bva = parsed.budgetVsActual.map(r => ({ ...stamp, period, ...r, updated_at: new Date().toISOString() }))
  await insertChunks(db, 'gl_monthly', bva, { upsert: true, onConflict: 'deal_id,period,account_code' })

  // Transaction detail and bed snapshot are replaced wholesale for the month.
  await db.from('gl_detail').delete().eq('deal_id', dealId).eq('period', period)
  await insertChunks(db, 'gl_detail', parsed.glDetail.map(r => ({ ...stamp, period, ...r })))

  await insertChunks(db, 'balance_sheet', parsed.balanceSheet.map(r => ({ ...stamp, period, ...r })), {
    upsert: true, onConflict: 'deal_id,period,account_code',
  })

  if (parsed.beds.length) {
    await db.from('bed_snapshots').delete().eq('deal_id', dealId).eq('period', period)
    await insertChunks(db, 'bed_snapshots', parsed.beds.map(r => ({ ...stamp, period, ...r })))
  }
}

function headline(parsed) {
  const sum = (group, sign = 1) => parsed.budgetVsActual.filter(l => l.account_group === group).reduce((s, l) => s + sign * (l.actual || 0), 0)
  const sumB = group => parsed.budgetVsActual.filter(l => l.account_group === group).reduce((s, l) => s + (l.budget || 0), 0)
  const noi = sum('Income') - sum('Operating Expenses')
  const noiBudget = sumB('Income') - sumB('Operating Expenses')
  const beds = parsed.beds.filter(b => b.unit_type && !/catch all/i.test(b.unit_type))
  const vacant = beds.filter(b => (b.days_vacant || 0) > 0).length
  return {
    noi: Math.round(noi), noi_budget: Math.round(noiBudget),
    beds: beds.length, vacant_beds: vacant,
    gl_accounts: parsed.budgetVsActual.length, gl_transactions: parsed.glDetail.length,
    history_months: new Set(parsed.t12.map(r => r.period)).size,
  }
}

const safeKey = s => s.replace(/[^A-Za-z0-9._\-/ ]+/g, '_').replace(/\s+/g, ' ').trim()

// The whole pipeline for one email's worth of files.
// message: { id (inbound_messages.id) | null, subject }
export async function ingestPackage(db, { files, message, aliases }) {
  if (!files.length) return { status: 'no_attachments' }

  const hashed = files.map(f => ({ ...f, sha256: sha256(f.buffer) }))
  const contentHash = sha256(Buffer.from(hashed.map(f => f.sha256).sort().join('\n')))

  const { data: dup } = await db.from('packages').select('id').eq('content_hash', contentHash).maybeSingle()
  if (dup) return { status: 'duplicate', packageId: dup.id }

  let parsed = null, parseError = null
  try { parsed = parsePackage(hashed) } catch (e) { parseError = e.message }

  const names = hashed.map(f => f.name)
  const texts = [parsed?.propertyNames, message?.subject, ...names]
  const dealId = matchDeal(texts, aliases)
  const period = parsed?.period || guessPeriod([message?.subject, ...names])

  const { data: pkg, error: pkgErr } = await db.from('packages').insert({
    message_id: message?.id || null, deal_id: dealId, period, content_hash: contentHash,
    format: parsed?.format || 'unknown', status: 'received',
  }).select('id').single()
  if (pkgErr) throw new Error(`packages: ${pkgErr.message}`)

  // Raw files first, so nothing is lost even if parsing fails.
  const fileRows = []
  for (const f of hashed) {
    const storagePath = safeKey(`${dealId || 'unmatched'}/${period || 'unknown'}/${pkg.id}/${f.name}`)
    const { error } = await db.storage.from(BUCKET).upload(storagePath, f.buffer, {
      contentType: f.contentType || 'application/octet-stream', upsert: true,
    })
    if (error) throw new Error(`storage upload ${f.name}: ${error.message}`)
    fileRows.push({ package_id: pkg.id, filename: f.name, storage_path: storagePath, sha256: f.sha256, size_bytes: f.buffer.length, content_type: f.contentType })
  }
  await insertChunks(db, 'package_files', fileRows)

  const problems = []
  if (!dealId) problems.push('Could not match the package to a deal; add an alias in deal_aliases')
  if (!period) problems.push('Could not tell which month the package covers')
  if (!parsed) problems.push(parseError ? `Parser error: ${parseError}` : 'No parser recognizes this package format yet; files are stored')

  if (parsed && dealId && period) {
    try {
      await storeParsed(db, { dealId, packageId: pkg.id, parsed })
    } catch (e) {
      problems.push(`Saving parsed data failed: ${e.message}`)
    }
  }

  const status = problems.length ? 'needs_attention' : 'parsed'
  const summary = { ...(parsed ? headline(parsed) : {}), warnings: [...(parsed?.warnings || []), ...problems], files: names.length }
  await db.from('packages').update({ status, summary, error: problems.join('; ') || null }).eq('id', pkg.id)
  return { status, packageId: pkg.id, dealId, period, summary }
}
