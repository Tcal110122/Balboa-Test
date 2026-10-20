// Parser for Greystar monthly packages (Yardi Voyager exports).
//
// A Greystar package is a zip of Excel reports, each with a title block:
//   row 1  "<Property> (<yardi code>)"     row 2  report name
//   row 3  "Period = Sep 2026"
// Reports used here:
//   02. Variance Report - Current Month   Budget Comparison with a Note column
//   01a. Budget Comparison - Current Month (fallback when 02 is missing)
//   11. Trailing 12 Month Income Statement  "Statement (12 months)"
//   03. Balance Sheet
//   04. General Ledger
//   09. Rent Roll with Lease Charges        (parsed by lib/rentroll-parser.js)
// The Operating Report PDF and other PDFs are stored, not parsed.
//
// Yardi indents account names: posting accounts all share one indent
// (the most common one); headings and subtotals use other indents.

import * as XLSX from 'xlsx'
import { monthLabelToPeriod } from './coastal-ridge.js'
import { parseRentRoll } from '../rentroll-parser.js'

const ACCT = /^\d{5}-\d{3}$/
const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const str = v => (v === null || v === undefined ? '' : String(v).trim())
const indent = s => { const t = String(s || ''); return t.length - t.trimStart().length }
const isoDate = v => (v instanceof Date && !isNaN(v) ? v.toISOString().slice(0, 10) : null)

// Yardi ysi chart ranges: 4xxxx income, 5xxxx-6xxxx operating expense,
// 70000-71999 replacements / capital, everything above is below the line.
export function groupFor(code) {
  const n = parseInt(code.slice(0, 5), 10)
  if (n < 50000) return 'Income'
  if (n < 70000) return 'Operating Expenses'
  if (n < 72000) return 'Capital Improvements'
  return 'Non-operating Expenses'
}

function rowsOf(wb) {
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true })
}

// Title block -> { property, report, period }
function title(rows) {
  const lines = rows.slice(0, 6).map(r => str(r?.[0])).filter(Boolean)
  const periodLine = lines.find(l => /^Period\s*=/.test(l)) || lines.find(l => /^Month Year\s*=/.test(l)) || ''
  let period = null
  const m = periodLine.match(/=\s*(?:[A-Za-z]{3}\s+\d{4}-)?([A-Za-z]{3}\s+\d{4})\s*$/)
  if (m) period = monthLabelToPeriod(m[1])
  const my = periodLine.match(/Month Year\s*=\s*(\d{2})\/(\d{4})/)
  if (my) period = `${my[2]}-${my[1]}-01`
  const propLine = lines.find(l => /\([a-z0-9]+\)\s*$/i.test(l)) || ''
  return { property: propLine.replace(/\s*\([^)]*\)\s*$/, ''), report: lines.slice(0, 2).join(' | '), period }
}

// Posting accounts share one indent; headings and totals use others.
function leafIndent(rows, valueCol) {
  const counts = {}
  for (const r of rows) {
    if (!r || !ACCT.test(str(r[0])) || num(r[valueCol]) === null) continue
    if (/^total/i.test(str(r[1]))) continue
    const i = indent(r[1]); counts[i] = (counts[i] || 0) + 1
  }
  // The most common indent: posting accounts far outnumber subtotals.
  return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 5)
}

function headerRow(rows, label) {
  return rows.findIndex(r => r && r.some(c => str(c) === label))
}

// ---------------------------------------------------------------

export function parseBudgetComparison(rows) {
  const hdr = headerRow(rows, 'PTD Actual')
  if (hdr < 0) throw new Error('Budget comparison: header row not found')
  const h = rows[hdr].map(str)
  const col = {
    actual: h.indexOf('PTD Actual'), budget: h.indexOf('PTD Budget'),
    ytdActual: h.indexOf('YTD Actual'), ytdBudget: h.indexOf('YTD Budget'),
    annual: h.indexOf('Annual'), note: h.indexOf('Note'),
  }
  const body = rows.slice(hdr + 1)
  const leaf = leafIndent(body, col.actual)
  let section = null
  const lines = []
  let noiRow = null
  for (const r of body) {
    if (!r || !ACCT.test(str(r[0]))) continue
    const name = str(r[1]), ind = indent(r[1]), actual = num(r[col.actual])
    if (actual === null) { if (ind > 1) section = name; continue }
    if (/^net operating income$/i.test(name)) noiRow = actual
    if (ind !== leaf) continue
    lines.push({
      account_code: str(r[0]), account_name: name, account_group: groupFor(str(r[0])), section,
      actual, budget: num(r[col.budget]),
      ytd_actual: col.ytdActual >= 0 ? num(r[col.ytdActual]) : null,
      ytd_budget: col.ytdBudget >= 0 ? num(r[col.ytdBudget]) : null,
      annual_budget: col.annual >= 0 ? num(r[col.annual]) : null,
      // Yardi joins MTD and YTD notes with ";" + newline.
      manager_note: col.note >= 0 ? str(r[col.note]).replace(/;\s*\r?\n/g, '\n').replace(/;\s*$/, '') || null : null,
    })
  }
  return { lines, noiRow }
}

export function parseT12(rows) {
  const hdr = rows.findIndex(r => r && r.filter(c => monthLabelToPeriod(c)).length >= 6)
  if (hdr < 0) throw new Error('T12: month header not found')
  const months = rows[hdr].map((c, i) => ({ i, period: monthLabelToPeriod(c) })).filter(m => m.period)
  const body = rows.slice(hdr + 1)
  const leaf = leafIndent(body, months[0].i)
  let section = null
  const out = []
  for (const r of body) {
    if (!r || !ACCT.test(str(r[0]))) continue
    const name = str(r[1]), ind = indent(r[1])
    const hasNum = months.some(m => num(r[m.i]) !== null)
    if (!hasNum) { if (ind > 1) section = name; continue }
    if (ind !== leaf) continue
    for (const m of months) {
      const v = num(r[m.i])
      if (v !== null) out.push({ period: m.period, account_code: str(r[0]), account_name: name, account_group: groupFor(str(r[0])), section, actual: v })
    }
  }
  return out
}

export function parseBalanceSheet(rows) {
  const body = rows.slice(4)
  const leaf = leafIndent(body, 2)
  const out = []
  for (const r of body) {
    if (!r || !ACCT.test(str(r[0])) || indent(r[1]) !== leaf) continue
    const v = num(r[2])
    if (v !== null) out.push({ account_code: str(r[0]), account_name: str(r[1]), balance: v })
  }
  return out
}

export function parseGeneralLedger(rows) {
  const hdr = headerRow(rows, 'Debit')
  if (hdr < 0) throw new Error('General ledger: header row not found')
  const h = rows[hdr].map(str)
  const col = { date: h.indexOf('Date'), desc: h.indexOf('Person/Description'), control: h.indexOf('Control'), ref: h.indexOf('Reference'), debit: h.indexOf('Debit'), credit: h.indexOf('Credit'), remarks: h.indexOf('Remarks') }
  const out = []
  let account = null
  for (const r of rows.slice(hdr + 1)) {
    if (!r) continue
    const first = str(r[0])
    if (ACCT.test(first)) { account = first; continue } // "= Beginning Balance =" header for the account
    if (!account || !first || !str(r[1])) continue        // totals and deposit subtotals have no property
    const debit = num(r[col.debit]) || 0, credit = num(r[col.credit]) || 0
    const desc = str(r[col.desc]), remarks = str(r[col.remarks])
    const unit = (remarks.match(/\[([A-Z]?-?\d{2,4}[A-Z]?)\]/) || [])[1] || null
    out.push({
      account_code: account, txn_date: isoDate(r[col.date]), post_date: null,
      reference: str(r[col.ref]) || str(r[col.control]) || null, txn_type: str(r[col.control]).split('-')[0] || null,
      memo: remarks && remarks !== desc ? `${desc} | ${remarks}` : desc || null,
      unit, counterparty: /\(v\d+\)/.test(desc) ? desc.replace(/\s*\(v\d+\)\s*$/, '') : null,
      amount: Math.round((debit - credit) * 100) / 100, // debit-positive, same as other managers
    })
  }
  return out
}

// Units from the rent roll. bed_snapshots.days_vacant is set to 1 for a unit
// vacant on the rent-roll date (Yardi doesn't report days vacant here).
function unitsFromRentRoll(buffer) {
  const rr = parseRentRoll(buffer)
  if (rr.error || !rr.units?.length) return { asOf: null, units: [] }
  return {
    asOf: rr.asOf,
    units: rr.units.map(u => ({
      unit: u.unit, unit_type: u.utype || u.tier || 'Unit',
      market_rent: u.market ?? null, potential_rent: u.inplace ?? null,
      days_vacant: u.vacant ? 1 : 0, vacancy_loss: null, scheduled_rent: u.inplace ?? null,
    })),
  }
}

// ---------------------------------------------------------------

export function parseGreystarPackage(files) {
  const reports = {}
  let rentRollFile = null
  for (const f of files) {
    if (!/\.xlsx?$/i.test(f.name)) continue
    let wb
    try { wb = XLSX.read(f.buffer, { type: 'buffer', cellDates: true }) } catch { continue }
    const rows = rowsOf(wb)
    const t = title(rows)
    const report = t.report.toLowerCase()
    if (report.includes('rent roll with lease charges')) { rentRollFile = f; reports.rentRoll ||= t; continue }
    if (!/\([a-z0-9]+\)/i.test(rows[0]?.[0] || '') ) continue // not a Yardi export
    const hasNote = rows.slice(0, 8).some(r => r && r.some(c => str(c) === 'Note'))
    if (report.includes('budget comparison') && /period = [a-z]{3} \d{4}$/i.test(rows[2]?.[0] || '')) {
      if (hasNote) reports.variance = { ...t, rows }
      else reports.budget ||= { ...t, rows }
    } else if (report.includes('statement (12 months)')) reports.t12 = { ...t, rows }
    else if (report.includes('balance sheet')) reports.balance = { ...t, rows }
    else if (report.includes('general ledger')) reports.gl = { ...t, rows }
  }
  const bvaReport = reports.variance || reports.budget
  if (!bvaReport) return null // not a Greystar/Yardi package

  const warnings = []
  const bva = parseBudgetComparison(bvaReport.rows)
  if (!reports.variance) warnings.push('No variance report with manager notes; used the budget comparison')
  const period = bvaReport.period
  const t12 = reports.t12 ? parseT12(reports.t12.rows) : []
  if (!reports.t12) warnings.push('No trailing 12-month statement found')
  const balanceSheet = reports.balance ? parseBalanceSheet(reports.balance.rows) : []
  const glDetail = reports.gl ? parseGeneralLedger(reports.gl.rows) : []
  const rr = rentRollFile ? unitsFromRentRoll(rentRollFile.buffer) : { units: [] }
  if (!rr.units.length) warnings.push('No rent roll units found')

  // Tie-out against Yardi's own NOI line.
  const sum = (g, k) => bva.lines.filter(l => l.account_group === g).reduce((s, l) => s + (l[k] || 0), 0)
  const noi = sum('Income', 'actual') - sum('Operating Expenses', 'actual')
  if (bva.noiRow !== null && Math.abs(noi - bva.noiRow) > 1) warnings.push(`Parsed NOI $${noi.toFixed(2)} differs from the report's $${bva.noiRow.toFixed(2)}`)

  return {
    format: 'greystar-yardi',
    manager: 'greystar',
    period,
    propertyNames: bvaReport.property,
    budgetVsActual: bva.lines,
    t12,
    glDetail,
    balanceSheet,
    beds: rr.units,
    warnings,
  }
}
