/**
 * Parser for the "comparison report" T-12 format used by One at the Peninsula.
 *
 * Format characteristics:
 *   Row 0: Excel Date objects at each month column (no text "Jan 2025" headers)
 *   Row 1: "Actual" or "Budget" label for each column
 *   Col 0: Row label (sometimes multi-line with \r\n — first line is the label)
 *   Data:  Subtotal rows (Total Income, Total Expenses, etc.) carry values at the
 *          "Actual" columns identified from row 1.
 *
 * Only Actual months are extracted (Budget columns are ignored).
 */

import * as XLSX from 'xlsx'

function num(v) {
  if (v == null) return null
  if (typeof v === 'number') return v
  const s = String(v).replace(/,/g, '').trim()
  if (/^\([\d.]+\)$/.test(s)) return -parseFloat(s.slice(1, -1))
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

function toMonthLabel(dateVal) {
  let d = dateVal
  if (typeof d === 'number') d = new Date(Math.round((d - 25569) * 86400 * 1000))
  if (!(d instanceof Date) || isNaN(d)) return null
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
  return mo + ' ' + d.getUTCFullYear()
}

export function parseComparisonT12(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })

  // --- Detect Actual columns from row 1 ---
  const row0 = grid[0] || []
  const row1 = grid[1] || []

  // Map col index → month label from any Date object in row 0
  const colToMonth = {}
  row0.forEach((v, ci) => {
    const lbl = toMonthLabel(v)
    if (lbl) colToMonth[ci] = lbl
  })

  // Find all columns where row 1 = "Actual"
  const actualCols = []
  row1.forEach((v, ci) => {
    if (typeof v === 'string' && /^actual$/i.test(v.trim())) actualCols.push(ci)
  })

  if (!actualCols.length) return { error: 'Could not find any Actual month columns — is this a comparison report?' }

  // Assign month label to each actual column: use nearest preceding Date column
  const months = actualCols.map((ci, idx) => {
    let label = null
    for (let c = ci; c >= 0; c--) {
      if (colToMonth[c]) { label = colToMonth[c]; break }
    }
    return { ci, label: label || ('Month ' + (idx + 1)) }
  })

  // Dedupe months (same label appearing twice due to budget/actual side-by-side)
  const seen = new Set()
  const uniqueMonths = months.filter(m => {
    if (seen.has(m.label)) return false
    seen.add(m.label); return true
  })

  const period = uniqueMonths.length
    ? uniqueMonths[0].label + (uniqueMonths.length > 1 ? ' – ' + uniqueMonths[uniqueMonths.length - 1].label : '')
    : ''

  // --- Row reader ---
  const readRow = (rowIdx) => {
    if (rowIdx < 0) return null
    const row = grid[rowIdx] || []
    const vals = uniqueMonths.map(m => num(row[m.ci]))
    const total = vals.reduce((s, v) => v != null ? s + v : s, 0)
    const hasData = vals.some(v => v != null)
    return hasData ? { vals, total } : null
  }

  // Find a row by label regex matching col 0 (handles multi-line cells — checks first line)
  const findRow = (re) => {
    for (let r = 2; r < grid.length; r++) {
      const cell = String(grid[r]?.[0] || '').trim()
      const firstLine = cell.split(/\r?\n/)[0].trim()
      if (re.test(firstLine) || re.test(cell)) return r
    }
    return -1
  }

  const fig = (re, label, acct = '') => {
    const r = findRow(re)
    const d = readRow(r)
    if (!d) return null
    return { label, acct, vals: d.vals, total: d.total }
  }

  // Combine multiple rows into one (for composite categories)
  const combineRows = (regexes, label, acct) => {
    const parts = regexes.map(re => fig(re, label, acct)).filter(Boolean)
    if (!parts.length) return null
    const vals = uniqueMonths.map((_, i) =>
      parts.reduce((s, p) => p.vals[i] != null ? s + p.vals[i] : s, 0) || null
    )
    return { label, acct, vals, total: vals.reduce((s, v) => v != null ? s + v : s, 0) }
  }

  // --- Key figures ---
  const totalIncome   = fig(/^total income$/i,               'Total Income',             '49999-999')
  const totalOpEx     = fig(/^total expenses?$/i,             'Total Operating Expenses', '66999-199')
  const noi           = fig(/^net operating income$/i,        'Net Operating Income',     '69999-099')
  const potentialRent = fig(/^total (possible|net) rent$/i,   'Potential Rent',           '41029-099')
  const otherIncome   = fig(/^total other income$/i,          'Total Other Income',       '43599-099')

  const incomeLines = [potentialRent, otherIncome].filter(Boolean)

  // --- Expense categories ---
  // Maintenance = Maintenance & Repair + Contracted Services + Painting & Decorating
  const maintenance = combineRows(
    [/^total maintenance/i, /^total contracted services?$/i, /^total painting/i],
    'General Maintenance', '53999-099'
  )

  // Taxes & Insurance may be combined; try to split, otherwise put in Taxes
  const taxInsTotal = fig(/^total tax\s*[&and]+\s*insurance/i, 'Taxes & Insurance', '62999-099')
  // Try to find real estate tax subtotal separately
  const taxesOnly  = fig(/^total (real estate )?taxes?$/i, 'Taxes', '62999-099')
  const insurOnly  = fig(/^total insurance/i,             'Insurance', '63999-099')

  const categories = [
    fig(/^total salaries expense$/i,        'Payroll & Benefits',       '51599-099'),
    maintenance,
    fig(/^total advertising/i,              'Advertising / Marketing',  '54999-099'),
    fig(/^total administrative expense$/i,  'General & Administrative', '58399-099'),
    fig(/^total utilities$/i,               'Utilities',                '59999-099'),
    fig(/^total management fees?$/i,        'Management Fees',          '61999-099'),
    taxesOnly || taxInsTotal,
    insurOnly,
  ].filter(Boolean)

  return {
    months: uniqueMonths,
    period,
    totalIncome, totalOpEx, noi,
    noiAfterRepl: null,
    potentialRent,
    incomeLines,
    categories,
    belowNOI: [],
  }
}
