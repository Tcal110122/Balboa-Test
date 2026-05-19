import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }
function toMonKey(label) { return String(label || '').slice(0, 3).toLowerCase() }

export function parseRPMBudget(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })

  const sheetName = wb.SheetNames.find(n => /modeldetailview/i.test(n))
  if (!sheetName) return { error: 'No "ModelDetailView" sheet found' }

  const ws = wb.Sheets[sheetName]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })

  // Find header row ("Account Description" in col 0)
  const hdrIdx = grid.findIndex(r => String((r || [])[0] || '').trim() === 'Account Description')
  if (hdrIdx < 0) return { error: 'Could not find column headers in ModelDetailView' }

  const monthKeys = grid[hdrIdx].slice(1, 13).map(toMonKey) // ['jan','feb',...,'dec']

  function rowToMonths(row) {
    const out = {}
    monthKeys.forEach((m, i) => { out[m] = num(row[i + 1]) })
    return out
  }
  function nullMonths() {
    const out = {}
    monthKeys.forEach(m => { out[m] = null })
    return out
  }

  // Index every subtotal / account row that has numeric month values
  const sections = {}
  for (const row of grid.slice(hdrIdx + 1)) {
    const label = String((row || [])[0] || '').trim()
    if (!label || label === 'Comments') continue
    const hasNums = monthKeys.some((_, i) => num(row[i + 1]) != null)
    if (!hasNums) continue
    // Use the raw label as key — later lookups use regex
    sections[label] = rowToMonths(row)
  }

  function sec(re) {
    const key = Object.keys(sections).find(k => re.test(k))
    return key ? sections[key] : null
  }

  const incomeMonths = sec(/^total revenue/i)
  const opexMonths   = sec(/^total expense/i)
  const noiMonths    = sec(/^total net operating income/i)

  if (!incomeMonths || !opexMonths || !noiMonths) {
    return { error: 'Could not locate Total Revenue, Total Expense, or NOI in ModelDetailView' }
  }

  // Map budget expense categories to T-12 GL codes used by the scorecard renderer.
  // G&A and Marketing are merged into a single code (mirrors how Darby's T-12 reports them).
  const gaMonths  = sec(/^general & administrative$/i)
  const mktMonths = sec(/^marketing$/i)
  const gaMerged  = {}
  monthKeys.forEach(m => {
    gaMerged[m] = ((gaMonths && gaMonths[m]) || 0) + ((mktMonths && mktMonths[m]) || 0)
  })

  const catByMonth = {
    '51599-099': { budget: sec(/^payroll$/i)             || nullMonths(), actual: nullMonths() },
    '53999-099': { budget: sec(/^repairs & maintenance$/i)|| nullMonths(), actual: nullMonths() },
    '58399-099': { budget: gaMerged,                                       actual: nullMonths() },
    '57399-099': { budget: sec(/^utilities$/i)            || nullMonths(), actual: nullMonths() },
    '60399-099': { budget: sec(/^management fees$/i)      || nullMonths(), actual: nullMonths() },
    '55999-099': { budget: sec(/^taxes$/i)                || nullMonths(), actual: nullMonths() },
    '56399-199': { budget: sec(/^insurance$/i)            || nullMonths(), actual: nullMonths() },
  }

  return {
    sheetName,
    source: 'rpm',
    monthOrder: monthKeys,
    currentMonth: null,
    headline: null,
    catLines: null,
    scorecard: {
      income: { budget: incomeMonths, actual: nullMonths() },
      opex:   { budget: opexMonths,   actual: nullMonths() },
      noi:    { budget: noiMonths,     actual: nullMonths() },
      noiAR:  { budget: noiMonths,     actual: nullMonths() },
      catByMonth
    }
  }
}
