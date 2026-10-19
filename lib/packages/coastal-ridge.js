// Parser for Coastal Ridge monthly packages (Entrata exports).
//
// A Coastal Ridge package is a zip with:
//   1 - Financials/<yyyy-mm> <Property> Financial Statements.xlsx
//       tabs: Balance Sheet, Income Statement - Budget Vs Ac(tual),
//             Income Statement, T12, Trial Balance, GL Details
//   4 - Other/<Property> - Gross Potential Rent -- <mm.yyyy>.xlsx
//   ...plus PDFs (bank recs, loan statements, AR/AP aging) that are
//   stored but not parsed here.
//
// The parser is pure: it takes { filename -> Buffer } and returns rows.
// Writing to Supabase happens in lib/packages/store.js.

import * as XLSX from 'xlsx'

const ACCT = /^\d{4}-\d{3}$/
const GROUPS = new Set(['Income', 'Operating Expenses', 'Non-operating Expenses', 'Capital Improvements'])
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

// 'Sep 2026' -> '2026-09-01'
export function monthLabelToPeriod(label) {
  const m = String(label || '').trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/)
  if (!m) return null
  const mo = MONTHS[m[1].toLowerCase()]
  return mo ? `${m[2]}-${String(mo).padStart(2, '0')}-01` : null
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const str = v => (v === null || v === undefined ? '' : String(v).trim())
const isoDate = v => (v instanceof Date && !isNaN(v) ? v.toISOString().slice(0, 10) : null)

function sheetRows(wb, name) {
  const ws = wb.Sheets[name]
  if (!ws) return null
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })
}

function findSheet(wb, prefix) {
  return wb.SheetNames.find(n => n.toLowerCase().startsWith(prefix.toLowerCase())) || null
}

function findHeaderRow(rows, firstCells) {
  return rows.findIndex(r => r && firstCells.every((c, i) => str(r[i]).toLowerCase() === c.toLowerCase()))
}

// ---------------------------------------------------------------
// Detection
// ---------------------------------------------------------------

export function isFinancialWorkbook(wb) {
  return Boolean(findSheet(wb, 'Income Statement - Budget') && wb.Sheets['T12'] && wb.Sheets['GL Details'])
}

export function isGprWorkbook(wb) {
  const rows = sheetRows(wb, wb.SheetNames[0]) || []
  return rows.slice(0, 10).some(r => r && str(r[0]) === 'Bldg-Unit' && str(r[2]).startsWith('GPR'))
}

// ---------------------------------------------------------------
// Budget vs actual (with manager variance notes)
// ---------------------------------------------------------------

export function parseBudgetVsActual(wb) {
  const name = findSheet(wb, 'Income Statement - Budget')
  const rows = sheetRows(wb, name)
  const hdr = findHeaderRow(rows, ['Account', 'Account Name'])
  if (hdr < 0) throw new Error('Budget vs actual: header row not found')

  const h = rows[hdr].map(str)
  const idx = label => h.indexOf(label)
  const second = label => h.indexOf(label, h.indexOf(label) + 1)
  const col = {
    actual: idx('Actual'), budget: idx('Budget'), note: idx('Variance Notes'),
    ytdActual: second('Actual'), ytdBudget: second('Budget'), annual: idx('Annual Budget'),
  }
  if (col.actual < 0 || col.budget < 0) throw new Error('Budget vs actual: Actual/Budget columns not found')

  // The property names and the month sit in the title rows above the header.
  const titles = rows.slice(0, hdr).map(r => (r ? r.map(str).filter(Boolean) : [])).filter(r => r.length)
  let period = null
  for (const t of titles) for (const cell of t) period = period || monthLabelToPeriod(cell)
  const propertyLine = titles.find(t => t.length === 1 && t[0].includes(',')) || titles[1] || []

  let group = null, section = null
  const lines = []
  for (const r of rows.slice(hdr + 1)) {
    if (!r) continue
    const a = str(r[0])
    if (ACCT.test(a)) {
      lines.push({
        account_code: a,
        account_name: str(r[1]),
        account_group: group,
        section,
        actual: num(r[col.actual]),
        budget: num(r[col.budget]),
        ytd_actual: col.ytdActual > 0 ? num(r[col.ytdActual]) : null,
        ytd_budget: col.ytdBudget > 0 ? num(r[col.ytdBudget]) : null,
        annual_budget: col.annual > 0 ? num(r[col.annual]) : null,
        manager_note: col.note >= 0 ? str(r[col.note]) || null : null,
      })
    } else if (a && r.slice(1, 6).every(c => c === null || c === '')) {
      if (GROUPS.has(a)) { group = a; section = null } else section = a
    }
  }
  return { period, propertyNames: propertyLine.join(', '), lines }
}

// ---------------------------------------------------------------
// Trailing 12 — monthly actuals for history
// ---------------------------------------------------------------

export function parseT12(wb) {
  const rows = sheetRows(wb, 'T12')
  const hdr = findHeaderRow(rows, ['Account', 'Account Name'])
  if (hdr < 0) throw new Error('T12: header row not found')
  const months = rows[hdr].map((c, i) => ({ i, period: monthLabelToPeriod(c) })).filter(m => m.period)

  const out = []
  let group = null, section = null
  for (const r of rows.slice(hdr + 1)) {
    if (!r) continue
    const a = str(r[0])
    if (!ACCT.test(a)) {
      // Same heading layout as the budget-vs-actual tab.
      if (a && r.slice(1, 6).every(c => c === null || c === '')) {
        if (GROUPS.has(a)) { group = a; section = null } else section = a
      }
      continue
    }
    for (const m of months) {
      const v = num(r[m.i])
      if (v === null) continue
      out.push({ period: m.period, account_code: a, account_name: str(r[1]), account_group: group, section, actual: v })
    }
  }
  return out
}

// ---------------------------------------------------------------
// Balance sheet — current month column only
// ---------------------------------------------------------------

export function parseBalanceSheet(wb) {
  const rows = sheetRows(wb, 'Balance Sheet')
  if (!rows) return []
  const hdr = findHeaderRow(rows, ['Account', 'Account Name'])
  if (hdr < 0) return []
  const out = []
  for (const r of rows.slice(hdr + 1)) {
    if (!r || !ACCT.test(str(r[0]))) continue
    const v = num(r[2])
    if (v !== null) out.push({ account_code: str(r[0]), account_name: str(r[1]), balance: v })
  }
  return out
}

// ---------------------------------------------------------------
// GL detail — one row per transaction
// ---------------------------------------------------------------

export function parseGlDetail(wb) {
  const rows = sheetRows(wb, 'GL Details')
  const hdr = findHeaderRow(rows, ['Property', 'Account'])
  if (hdr < 0) throw new Error('GL Details: header row not found')
  const h = rows[hdr].map(str)
  const c = name => h.indexOf(name)
  const col = {
    acct: c('Account'), txn: c('Transaction Date'), post: c('Post Date'), ref: c('Reference'),
    type: c('Transaction Type'), memo: c('Memo/Note'), unit: c('BLDG-Unit'), party: c('Resident/Vendor'),
    debit: c('Debit'), credit: c('Credit'),
  }
  const out = []
  for (const r of rows.slice(hdr + 1)) {
    // Transaction lines carry the property name in column A and an account in column B;
    // "GL Account:" headers, beginning balances and subtotals don't.
    if (!r || !str(r[0]) || str(r[0]).startsWith('GL Account') || !ACCT.test(str(r[col.acct]))) continue
    const amount = (num(r[col.debit]) || 0) + (num(r[col.credit]) || 0)
    out.push({
      account_code: str(r[col.acct]),
      txn_date: isoDate(r[col.txn]),
      post_date: isoDate(r[col.post]),
      reference: str(r[col.ref]) || null,
      txn_type: str(r[col.type]) || null,
      memo: str(r[col.memo]) || null,
      unit: str(r[col.unit]) || null,
      counterparty: str(r[col.party]) || null,
      amount: Math.round(amount * 100) / 100,
    })
  }
  return out
}

// ---------------------------------------------------------------
// Gross potential rent — one row per bed/unit
// ---------------------------------------------------------------

export function parseGpr(wb) {
  const rows = sheetRows(wb, wb.SheetNames[0])
  const hdr = rows.findIndex(r => r && str(r[0]) === 'Bldg-Unit')
  if (hdr < 0) return { period: null, beds: [] }
  const h = rows[hdr].map(str)
  const c = name => h.indexOf(name)
  const col = {
    type: c('Unit Type'), market: c('GPR - Market Rent'), potential: c('Potential Rent'),
    days: c('Days Vacant'), vacancy: c('Vacancy Loss'), scheduled: c('Scheduled Rent'),
  }
  let period = null
  for (const r of rows.slice(0, hdr)) for (const cell of r || []) period = period || monthLabelToPeriod(cell)

  const beds = []
  for (const r of rows.slice(hdr + 1)) {
    if (!r || !str(r[0]) || num(r[col.market]) === null || !str(r[col.type])) continue
    beds.push({
      unit: str(r[0]),
      unit_type: str(r[col.type]),
      market_rent: num(r[col.market]),
      potential_rent: num(r[col.potential]),
      days_vacant: num(r[col.days]),
      vacancy_loss: num(r[col.vacancy]),
      scheduled_rent: num(r[col.scheduled]),
    })
  }
  return { period, beds }
}

// ---------------------------------------------------------------
// Whole package
// ---------------------------------------------------------------

// files: Array<{ name: string, buffer: Buffer }>
export function parseCoastalRidgePackage(files) {
  const warnings = []
  let fin = null, gpr = null
  for (const f of files) {
    if (!/\.xlsx?$/i.test(f.name)) continue
    let wb
    try { wb = XLSX.read(f.buffer, { type: 'buffer', cellDates: true }) } catch { warnings.push(`Could not open ${f.name}`); continue }
    if (!fin && isFinancialWorkbook(wb)) fin = { name: f.name, wb }
    else if (!gpr && isGprWorkbook(wb)) gpr = { name: f.name, wb }
  }
  if (!fin) return null // not a Coastal Ridge package

  const bva = parseBudgetVsActual(fin.wb)
  const t12 = parseT12(fin.wb)
  const glDetail = parseGlDetail(fin.wb)
  const balanceSheet = parseBalanceSheet(fin.wb)
  const g = gpr ? parseGpr(gpr.wb) : { period: null, beds: [] }

  if (!bva.period) warnings.push('Reporting month not found on the budget vs actual tab')
  if (gpr && g.period && bva.period && g.period !== bva.period) warnings.push(`GPR month ${g.period} differs from financials ${bva.period}`)
  if (!gpr) warnings.push('No gross potential rent workbook found')

  // Self-checks against the manager's own subtotals.
  const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0)
  const t12Current = t12.filter(r => r.period === bva.period)
  const diff = Math.abs(sum(t12Current, 'actual') - sum(bva.lines, 'actual'))
  if (t12Current.length && diff > 1) warnings.push(`T12 ${bva.period} actuals differ from budget vs actual by $${diff.toFixed(2)}`)

  return {
    format: 'coastal-ridge-entrata',
    manager: 'coastal-ridge',
    period: bva.period,
    propertyNames: bva.propertyNames,
    budgetVsActual: bva.lines,
    t12,
    glDetail,
    balanceSheet,
    beds: g.beds,
    warnings,
  }
}
