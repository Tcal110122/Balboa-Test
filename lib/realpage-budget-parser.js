/**
 * Parser for RealPage conventional (Jan–Dec) budget exports.
 *
 * Format:
 *   Row 0:  "RealPage© Budgeting"
 *   Row 6:  "For the Budget Year Beginning January YYYY"
 *   Row 10: "Account Description" | "Jan-YYYY" | "Feb-YYYY" | ... | "Dec-YYYY" | "Total"
 *   Rows:   Line items with monthly amounts + annual total
 *
 * Returns the same scorecard/catLines structure the Income tab expects.
 */

import * as XLSX from 'xlsx'

const MON3 = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

function num(v) {
  if (v == null) return null
  if (typeof v === 'number') return isNaN(v) ? null : v
  const n = parseFloat(String(v).replace(/[$,]/g, ''))
  return isNaN(n) ? null : n
}

export function parseRealPageBudget(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })

  // Find header row: has "Account Description" in col 0 and month labels in subsequent cols
  let hdrRow = -1
  const monCols = {} // 'jan' -> colIndex
  for (let r = 0; r < Math.min(15, grid.length); r++) {
    const row = grid[r] || []
    const hits = []
    row.forEach((v, ci) => {
      const s = String(v || '').trim()
      const m = s.match(/^([A-Za-z]{3})-(\d{2,4})$/)
      if (m) hits.push({ ci, mon: m[1].toLowerCase() })
    })
    if (hits.length >= 10) {
      hdrRow = r
      hits.forEach(h => { if (MON3.includes(h.mon)) monCols[h.mon] = h.ci })
      break
    }
  }
  if (hdrRow < 0) return { error: 'Could not find month header row in RealPage budget.' }

  const monthOrder = MON3.filter(m => monCols[m] != null)

  // Read a row's monthly values as { jan: N, feb: N, ... }
  const readMonths = (rowIdx) => {
    const row = grid[rowIdx] || []
    const obj = {}
    monthOrder.forEach(m => { obj[m] = num(row[monCols[m]]) })
    return obj
  }

  // Find a row by label regex in col 0 that also has numeric values in month columns
  const findRow = (re) => {
    for (let r = hdrRow + 1; r < grid.length; r++) {
      const label = String(grid[r]?.[0] || '').trim()
      if (!re.test(label)) continue
      const row = grid[r] || []
      const hasValues = monthOrder.some(m => row[monCols[m]] != null && typeof row[monCols[m]] === 'number')
      if (hasValues) return r
    }
    return -1
  }

  const budMonths = (re) => {
    const r = findRow(re)
    return r >= 0 ? readMonths(r) : null
  }

  // Key totals
  const income  = budMonths(/^TOTAL INCOME$/i)
  const opex    = budMonths(/^TOTAL OPERATING EXPENSE$/i)
  const noi     = budMonths(/^Total NET OPERATING INCOME$/i)

  // Expense categories → map to standard account codes
  const salaries    = budMonths(/^Salaries Expense$/i)
  // General maintenance = Maintenance & Repair + Painting & Decorating + Contracted Services
  const maintRaw    = budMonths(/^Maintenance & Repair$/i)
  const paintRaw    = budMonths(/^Painting & Decorating$/i)
  const contractRaw = budMonths(/^Contracted Services$/i)
  const maint = monthOrder.reduce((o, m) => {
    o[m] = (maintRaw?.[m] || 0) + (paintRaw?.[m] || 0) + (contractRaw?.[m] || 0) || null
    return o
  }, {})

  const advert = budMonths(/^Advertising & Promotion$/i)
  const admin  = budMonths(/^Administrative Expense$/i)
  const util   = budMonths(/^Utilities$/i)
  const mgmt   = budMonths(/^Management Fees$/i)
  const taxIns = budMonths(/^Tax & Insurance Expense$/i)

  // Build scorecard structure (budget side; actual always null — filled by T-12 overlay)
  const nullMonths = () => monthOrder.reduce((o, m) => { o[m] = null; return o }, {})
  const sc = (bud) => ({ budget: bud || nullMonths(), actual: nullMonths() })

  const scorecard = {
    income:  sc(income),
    opex:    sc(opex),
    noi:     sc(noi),
    noiAR:   sc(noi),  // no replacement reserve line in this format
    catByMonth: {
      '51599-099': sc(salaries),
      '53999-099': sc(maint),
      '54999-099': sc(advert),
      '58399-099': sc(admin),
      '59999-099': sc(util),
      '61999-099': sc(mgmt),
      '62999-099': sc(taxIns),
      '63999-099': sc(nullMonths()),  // insurance folded into taxIns above
    },
  }

  // catLines: used by the YTD expense detail section
  const catLine = (bud) => {
    if (!bud) return null
    const monthly = { ...bud }
    const fyBudget = monthOrder.reduce((s, m) => s + (bud[m] || 0), 0)
    return { monthly, fyBudget, ytdBudget: null, ytdActual: null, ytdVar: null }
  }

  const catLines = {
    '51599-099': catLine(salaries),
    '53999-099': catLine(maint),
    '54999-099': catLine(advert),
    '58399-099': catLine(admin),
    '59999-099': catLine(util),
    '61999-099': catLine(mgmt),
    '62999-099': catLine(taxIns),
    '63999-099': catLine(null),
  }

  return {
    sheetName: wb.SheetNames[0],
    monthOrder,
    closedMonths: [],
    currentMonth: null,
    headline: null,
    catLines,
    scorecard,
    budgetType: 'conventional',
  }
}
