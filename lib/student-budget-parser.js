import * as XLSX from 'xlsx'

function num(v) {
  const n = parseFloat(String(v || '').replace(/,/g, ''))
  return isNaN(n) ? null : n
}

const MONS = ['aug','sep','oct','nov','dec','jan','feb','mar','apr','may','jun','jul']
const MON_NUM = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 }

export function parseStudentBudget(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })

  // Confirm RealPage format
  const topText = grid.slice(0, 8).map(r => String(r[0] || '')).join(' ')
  if (!/realpage|budget year beginning/i.test(topText)) {
    return { error: 'Not a RealPage student budget — expected "RealPage Budgeting" header' }
  }

  // Find header row: has "Account Description" in col 0
  let hdrRow = -1
  for (let i = 0; i < 15; i++) {
    if (/account description/i.test(String((grid[i] || [])[0] || ''))) { hdrRow = i; break }
  }
  if (hdrRow < 0) return { error: 'Could not find the Account Description header row' }

  const hdr = (grid[hdrRow] || []).map(v => String(v || '').trim())

  // Map month columns from headers like "Aug-2025", "Jan-2026"
  const monCol = {}
  const monYear = {}
  hdr.forEach((v, ci) => {
    const m = v.match(/^([A-Za-z]{3})[- ](\d{4})$/i)
    if (m) {
      const k = m[1].toLowerCase()
      if (MONS.includes(k) && monCol[k] == null) {
        monCol[k] = ci
        monYear[k] = parseInt(m[2])
      }
    }
  })

  const totalCol = hdr.findIndex(v => /^total$/i.test(v))

  if (!Object.keys(monCol).length) return { error: 'Could not locate monthly budget columns' }

  // Find the LAST row matching a label (subtotal rows repeat the section header label)
  const findLastRow = re => {
    let found = -1
    for (let r = hdrRow + 1; r < grid.length; r++) {
      if (re.test(String((grid[r] || [])[0] || '').trim())) found = r
    }
    return found
  }

  const line = re => {
    const r = findLastRow(re)
    if (r < 0) return null
    const row = grid[r]
    const monthly = {}
    MONS.forEach(k => { monthly[k] = monCol[k] != null ? num(row[monCol[k]]) : null })
    return {
      row: r,
      fyBudget: totalCol >= 0 ? num(row[totalCol]) : null,
      monthly,
      ytdActual: null, ytdBudget: null, ytdVar: null
    }
  }

  const sumLines = (...res) => {
    const parts = res.map(re => line(re)).filter(Boolean)
    if (!parts.length) return null
    const monthly = {}
    MONS.forEach(k => {
      let s = 0, any = false
      parts.forEach(p => { if (p.monthly[k] != null) { s += p.monthly[k]; any = true } })
      monthly[k] = any ? s : null
    })
    const sum = f => parts.reduce((a, p) => a + (p[f] || 0), 0)
    return { monthly, fyBudget: sum('fyBudget'), ytdActual: null, ytdBudget: null, ytdVar: null }
  }

  const headline = {
    totalIncome: line(/^total income$/i),
    totalOpEx:   line(/^total expense$/i),
    noi:         line(/^total net operating income$/i),
    noiAR:       line(/^total net operating income$/i),
  }

  // Map RealPage section subtotals to the same category keys the income section uses
  const repairs = sumLines(
    /^service related expenses$/i,
    /^operating.*maintenance expenses$/i,
    /^maintenance.*repairs$/i
  )
  const catLines = {
    '51599-099': line(/^payroll.*related$/i),
    '53999-099': repairs,
    '54999-099': line(/^marketing expenses$/i),
    '58399-099': line(/^administrative expenses$/i),
    '59999-099': line(/^utilities$/i),
    '61999-099': line(/^management fees$/i),
    '62999-099': line(/^taxes.*insurance$/i),
    '63999-099': null,
  }

  // Build monthly scorecard budget from the file's own month columns
  // Actuals are filled in at render time from state.t12
  const mkSc = re => {
    const l = line(re)
    return { budget: l ? l.monthly : null, actual: null }
  }
  const scorecard = {
    income: mkSc(/^total income$/i),
    opex:   mkSc(/^total expense$/i),
    noi:    mkSc(/^total net operating income$/i),
    noiAR:  mkSc(/^total net operating income$/i),
    catByMonth: {
      '51599-099': { budget: catLines['51599-099']?.monthly ?? null, actual: null },
      '53999-099': { budget: repairs?.monthly ?? null, actual: null },
      '54999-099': { budget: catLines['54999-099']?.monthly ?? null, actual: null },
      '58399-099': { budget: catLines['58399-099']?.monthly ?? null, actual: null },
      '59999-099': { budget: catLines['59999-099']?.monthly ?? null, actual: null },
      '61999-099': { budget: catLines['61999-099']?.monthly ?? null, actual: null },
      '62999-099': { budget: catLines['62999-099']?.monthly ?? null, actual: null },
      '63999-099': { budget: null, actual: null },
    }
  }

  // Determine closed months based on current date vs. budget calendar
  const now = new Date()
  const closedMonths = MONS.filter(m => {
    const yr = monYear[m]
    if (!yr) return false
    const lastDay = new Date(yr, MON_NUM[m], 0)  // last day of the month
    return lastDay < now
  })

  return {
    sheetName: wb.SheetNames[0],
    monthOrder: MONS,
    closedMonths,
    currentMonth: closedMonths.length ? closedMonths[closedMonths.length - 1] : null,
    headline, catLines, scorecard,
    budgetType: 'student',
  }
}
