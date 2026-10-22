// Parser for Yardi Voyager reporting packages: Greystar and RPM.
//
// Greystar sends a zip of one-report workbooks; RPM sends a single
// "Reporting Package.xlsx" with one report per tab. Either way every report
// has a Yardi title block:
//   row 1  "<Property> (<yardi code>)"   row 2  report name
//   row 3  "Period = Sep 2026"            (rent roll: "As Of" / "Month Year")
// Reports used:
//   Budget Comparison with a Note column   Greystar "02. Variance Report",
//                                          RPM "Financial Notes" tab
//   Budget Comparison (no notes)            fallback
//   12-month income statement               "Statement (12 months)" / "12 Month Statement"
//   Balance Sheet, General Ledger
//   Rent Roll with Lease Charges            via lib/rentroll-parser.js
//
// Posting accounts vs. headings and subtotals: headings have no numbers;
// subtotals are named "Total ..."/"Net ...", sit at a different indent from
// the posting accounts (Greystar), or are ALL-CAPS lines whose amount equals
// the sum of the posting lines just above them (RPM). An all-caps account
// that isn't such a sum (e.g. "R&M - HVAC") is a posting account.

import * as XLSX from 'xlsx'
import { monthLabelToPeriod } from './coastal-ridge.js'
import { parseRentRoll } from '../rentroll-parser.js'

const ACCT = /^\d{4,5}-\d{3,4}$/
const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const str = v => (v === null || v === undefined ? '' : String(v).trim())
const indent = s => { const t = String(s || ''); return t.length - t.trimStart().length }
const isoDate = v => (v instanceof Date && !isNaN(v) ? v.toISOString().slice(0, 10) : null)
const allCaps = s => { const l = String(s).replace(/[^A-Za-z]/g, ''); return l.length >= 3 && l === l.toUpperCase() }
// Always subtotals, whatever the casing.
const isNamedTotal = s => /^total\b/i.test(s) || /^net\b/i.test(s) || /^cash flow$/i.test(s) || /net operating income/i.test(s)
// "REPAIRS & MAINTENANCE" -> "Repairs & Maintenance"
const tidy = s => (allCaps(s) ? s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\bR&m\b/g, 'R&M') : s)

// Fallback for 5-digit Yardi ysi charts when no heading says otherwise.
export function groupFor(code) {
  const n = parseInt(code.slice(0, 5), 10)
  if (code.split('-')[0].length !== 5 || isNaN(n)) return null
  if (n < 50000) return 'Income'
  if (n < 70000) return 'Operating Expenses'
  if (n < 72000) return 'Capital Improvements'
  return 'Non-operating Expenses'
}

// Walks headings/subtotals to know which part of the statement a row is in.
function groupTracker() {
  let group = null, section = null
  return {
    see(name, isHeading) {
      const n = name.trim()
      if (/net operating income/i.test(n)) { group = 'Non-operating Expenses'; section = null; return }
      if (!isHeading) return
      if (/^(revenue|income)$/i.test(n)) { group = 'Income'; section = null; return }
      if (/^(expenses|operating expenses)$/i.test(n)) { group = 'Operating Expenses'; section = null; return }
      if (/renovation|replacement|capital/i.test(n)) group = 'Capital Improvements'
      else if (/non.?operating|debt service|partnership|owner/i.test(n)) group = 'Non-operating Expenses'
      section = tidy(n)
    },
    get group() { return group },
    get section() { return section },
  }
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
  const reportLine = lines.find(l => l !== propLine && !/=/.test(l)) || ''
  return { property: propLine.replace(/\s*\([^)]*\)\s*$/, ''), report: reportLine, period }
}

function postingIndent(rows, hasValue) {
  const counts = {}
  for (const r of rows) {
    if (!r || !ACCT.test(str(r[0])) || !hasValue(r) || isNamedTotal(str(r[1])) || allCaps(str(r[1]))) continue
    const i = indent(r[1]); counts[i] = (counts[i] || 0) + 1
  }
  return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 5)
}

// Tracks posting lines since the last heading so an all-caps line can be
// tested as a running subtotal. values(r) -> number[] compared element-wise.
function subtotalDetector(values) {
  let recent = []
  const close = (a, b) => a.length === b.length && a.every((x, i) => Math.abs((x || 0) - (b[i] || 0)) < 0.02)
  return {
    reset() { recent = [] },
    isSubtotal(r) {
      const v = values(r)
      const acc = v.map(() => 0)
      for (let k = recent.length - 1; k >= 0; k--) {
        recent[k].forEach((x, i) => { acc[i] += x || 0 })
        if (close(acc, v)) return true
      }
      return false
    },
    add(r) { recent.push(values(r)) },
  }
}

function isPosting(code, name, ind, leaf, det, r) {
  if (!ACCT.test(code) || isNamedTotal(name) || ind !== leaf) return false
  if (allCaps(name) && det.isSubtotal(r)) return false
  return true
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
  const leaf = postingIndent(body, r => num(r[col.actual]) !== null)
  const g = groupTracker()
  const det = subtotalDetector(r => [num(r[col.actual]), num(r[col.ytdActual])])
  const lines = []
  let noiRow = null
  for (const r of body) {
    if (!r) continue
    const code = str(r[0]), name = str(r[1]), actual = num(r[col.actual])
    if (!name) continue
    if (actual === null) { g.see(name, true); continue }
    if (/net operating income/i.test(name) && noiRow === null) noiRow = actual
    g.see(name, false)
    if (!isPosting(code, name, indent(r[1]), leaf, det, r)) continue
    det.add(r)
    lines.push({
      account_code: code, account_name: name, account_group: g.group || groupFor(code), section: g.section,
      actual, budget: num(r[col.budget]),
      ytd_actual: col.ytdActual >= 0 ? num(r[col.ytdActual]) : null,
      ytd_budget: col.ytdBudget >= 0 ? num(r[col.ytdBudget]) : null,
      annual_budget: col.annual >= 0 ? num(r[col.annual]) : null,
      // Notes can carry a property-code prefix ("73600: ") and Yardi joins
      // MTD and YTD notes with ";" + newline.
      manager_note: col.note >= 0
        ? str(r[col.note]).replace(/^\d{4,6}:\s*/, '').replace(/;\s*\r?\n/g, '\n').replace(/;\s*$/, '') || null
        : null,
    })
  }
  return { lines, noiRow }
}

export function parseT12(rows) {
  const hdr = rows.findIndex(r => r && r.filter(c => monthLabelToPeriod(c)).length >= 6)
  if (hdr < 0) throw new Error('T12: month header not found')
  const months = rows[hdr].map((c, i) => ({ i, period: monthLabelToPeriod(c) })).filter(m => m.period)
  const body = rows.slice(hdr + 1)
  const hasValue = r => months.some(m => num(r[m.i]) !== null)
  const leaf = postingIndent(body, hasValue)
  const g = groupTracker()
  const det = subtotalDetector(r => months.map(m => num(r[m.i])))
  const out = []
  for (const r of body) {
    if (!r) continue
    const code = str(r[0]), name = str(r[1])
    if (!name) continue
    if (!hasValue(r)) { g.see(name, true); continue }
    g.see(name, false)
    if (!isPosting(code, name, indent(r[1]), leaf, det, r)) continue
    det.add(r)
    for (const m of months) {
      const v = num(r[m.i])
      if (v !== null) out.push({ period: m.period, account_code: code, account_name: name, account_group: g.group || groupFor(code), section: g.section, actual: v })
    }
  }
  return out
}

export function parseBalanceSheet(rows) {
  const body = rows.slice(4)
  const leaf = postingIndent(body, r => num(r[2]) !== null)
  const det = subtotalDetector(r => [num(r[2])])
  const out = []
  for (const r of body) {
    if (!r || num(r[2]) === null) continue
    if (!isPosting(str(r[0]), str(r[1]), indent(r[1]), leaf, det, r)) continue
    det.add(r)
    out.push({ account_code: str(r[0]), account_name: str(r[1]), balance: num(r[2]) })
  }
  return out
}

export function parseGeneralLedger(rows) {
  const hdr = headerRow(rows, 'Debit')
  if (hdr < 0) throw new Error('General ledger: header row not found')
  const h = rows[hdr].map(str)
  const col = { date: h.indexOf('Date'), desc: h.indexOf('Person/Description'), control: h.indexOf('Control'), ref: h.indexOf('Reference'), debit: h.indexOf('Debit'), credit: h.indexOf('Credit'), remarks: h.indexOf('Remarks'), unit: h.indexOf('Unit') }
  const out = []
  let account = null
  for (const r of rows.slice(hdr + 1)) {
    if (!r) continue
    const first = str(r[0])
    if (ACCT.test(first)) { account = first; continue } // "= Beginning Balance =" header for the account
    if (!account || !first || !str(r[1])) continue        // totals and subtotals have no property
    const debit = num(r[col.debit]) || 0, credit = num(r[col.credit]) || 0
    const desc = str(r[col.desc]), remarks = str(r[col.remarks])
    const unit = (col.unit >= 0 && str(r[col.unit])) || (remarks.match(/\[([A-Z]?-?\d{2,5}[A-Z]?)\]/) || [])[1] || null
    out.push({
      account_code: account, txn_date: isoDate(r[col.date]), post_date: null,
      reference: str(r[col.ref]) && str(r[col.ref]) !== 'none' ? str(r[col.ref]) : str(r[col.control]) || null,
      txn_type: str(r[col.control]).split('-')[0] || null,
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

// The rent roll parser reads the first sheet of a workbook, so a tab from a
// multi-tab package is copied into a workbook of its own.
function sheetAsWorkbook(wb, name) {
  const out = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(out, wb.Sheets[name], 'Report1')
  return XLSX.write(out, { type: 'buffer', bookType: 'xlsx' })
}

// ---------------------------------------------------------------

export function parseYardiPackage(files) {
  const reports = {}
  let rentRoll = null, isRpm = false
  for (const f of files) {
    if (!/\.xlsx?$/i.test(f.name)) continue
    let wb
    try { wb = XLSX.read(f.buffer, { type: 'buffer', cellDates: true }) } catch { continue }
    for (const sheet of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: null, raw: true })
      if (!rows.length) continue
      const t = title(rows)
      const report = t.report.toLowerCase()
      const head = rows.slice(0, 6).map(r => str(r?.[0])).join(' | ')
      if (/tree = rp-/i.test(head) || /^resanalytic/i.test(sheet)) isRpm = true
      if (report.includes('rent roll with lease charges')) { rentRoll ||= { wb, sheet, single: wb.SheetNames.length === 1, buffer: f.buffer }; continue }
      if (!/\([a-z0-9]+\)\s*$/i.test(head.split(' | ')[0] || '') && !/\([a-z0-9]+\)/i.test(head)) continue // not Yardi
      const hasNote = rows.slice(0, 8).some(r => r && r.some(c => str(c) === 'Note'))
      // Single-month comparisons only ("Period = Sep 2026", not "Jan 2026-Sep 2026").
      if (report === 'budget comparison' && t.period && /period = [a-z]{3} \d{4}( \||$)/i.test(head)) {
        if (hasNote) reports.variance ||= { ...t, rows }
        else reports.budget ||= { ...t, rows }
      } else if (/statement \(12 months\)|12 month statement/.test(report)) reports.t12 ||= { ...t, rows }
      else if (report.startsWith('balance sheet')) reports.balance ||= { ...t, rows }
      else if (report === 'general ledger') reports.gl ||= { ...t, rows }
    }
  }
  const bvaReport = reports.variance || reports.budget
  if (!bvaReport) return null // not a Yardi package

  const warnings = []
  const bva = parseBudgetComparison(bvaReport.rows)
  if (!reports.variance) warnings.push('No variance report with manager notes; used the budget comparison')
  const period = bvaReport.period
  const t12 = reports.t12 ? parseT12(reports.t12.rows) : []
  if (!reports.t12) warnings.push('No trailing 12-month statement found')
  const balanceSheet = reports.balance ? parseBalanceSheet(reports.balance.rows) : []
  if (!reports.balance) warnings.push('No balance sheet found')
  const glDetail = reports.gl ? parseGeneralLedger(reports.gl.rows) : []
  if (!reports.gl) warnings.push('No general ledger found')
  const rr = rentRoll ? unitsFromRentRoll(rentRoll.single ? rentRoll.buffer : sheetAsWorkbook(rentRoll.wb, rentRoll.sheet)) : { units: [] }
  if (!rr.units.length) warnings.push('No rent roll units found')

  // Tie-out against Yardi's own NOI line.
  const sum = (grp, k) => bva.lines.filter(l => l.account_group === grp).reduce((s, l) => s + (l[k] || 0), 0)
  const noi = sum('Income', 'actual') - sum('Operating Expenses', 'actual')
  if (bva.noiRow !== null && Math.abs(noi - bva.noiRow) > 1) warnings.push(`Parsed NOI $${noi.toFixed(2)} differs from the report's $${bva.noiRow.toFixed(2)}`)

  return {
    format: isRpm ? 'rpm-yardi' : 'greystar-yardi',
    manager: isRpm ? 'rpm' : 'greystar',
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

// Kept for older imports.
export const parseGreystarPackage = parseYardiPackage
