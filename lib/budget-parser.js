import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function parseBudget(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = wb.SheetNames.find(n => /rolling forecast/i.test(n))
  if (!sheetName) return { error: 'No "Rolling Forecast" sheet found in this workbook.' }

  const ws = wb.Sheets[sheetName]
  let mR = 0, mC = 0
  Object.keys(ws).forEach(k => {
    if (k[0] === '!') return
    const c = XLSX.utils.decode_cell(k)
    if (c.r > mR) mR = c.r
    if (c.c > mC) mC = c.c
  })
  if (mR > 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: mR, c: mC } })

  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })

  let hdrRow = -1
  for (let i = 0; i < 10 && i < grid.length; i++) {
    const cells = (grid[i] || []).map(v => String(v || '').trim().toLowerCase())
    const hit = MON.filter(m => cells.some(c => c === m || c.startsWith(m))).length
    if (hit >= 10) { hdrRow = i; break }
  }
  if (hdrRow < 0) return { error: 'Could not locate the month header row on the Rolling Forecast tab.' }

  const hdr = (grid[hdrRow] || []).map(v => String(v || '').trim())
  const lc = (re) => hdr.findIndex(v => re.test(v))

  const monCol = {}
  hdr.forEach((v, ci) => {
    const k = String(v || '').trim().toLowerCase().slice(0, 3)
    if (MON.includes(k) && monCol[k] == null) monCol[k] = ci
  })

  const cFY = lc(/full-?year\s*budget/i)
  const cYtdA = lc(/ytd actual/i), cYtdB = lc(/ytd budget/i), cYtdV = lc(/ytd var/i)

  let closedRow = -1
  for (let r = 0; r < grid.length; r++) {
    const a = String((grid[r] || [])[0] || '')
    if (/closed\?/i.test(a) && a.length < 90) { closedRow = r; break }
  }

  const closedMonths = []
  if (closedRow >= 0) {
    MON.forEach(k => {
      const v = grid[closedRow][monCol[k]]
      if (v != null && /^y/i.test(String(v).trim())) closedMonths.push(k)
    })
  }

  let blockEnd = grid.length
  for (let r = hdrRow + 3; r < grid.length; r++) {
    if (/^actuals/i.test(String((grid[r] || [])[0] || '').trim())) { blockEnd = r; break }
  }

  const findRow = (re) => {
    for (let r = hdrRow + 1; r < blockEnd; r++) {
      if (re.test(String((grid[r] || [])[0] || '').trim())) return r
    }
    return -1
  }

  const line = (re) => {
    const r = findRow(re)
    if (r < 0) return null
    const row = grid[r]
    const monthly = {}
    MON.forEach(k => { monthly[k] = monCol[k] != null ? num(row[monCol[k]]) : null })
    return {
      row: r, fyBudget: cFY >= 0 ? num(row[cFY]) : null,
      monthly,
      ytdActual: cYtdA >= 0 ? num(row[cYtdA]) : null,
      ytdBudget: cYtdB >= 0 ? num(row[cYtdB]) : null,
      ytdVar: cYtdV >= 0 ? num(row[cYtdV]) : null
    }
  }

  const sumLines = (...res) => {
    const parts = res.map(re => line(re)).filter(Boolean)
    if (!parts.length) return null
    const monthly = {}
    MON.forEach(k => {
      let s = 0, any = false
      parts.forEach(p => { if (p.monthly[k] != null) { s += p.monthly[k]; any = true } })
      monthly[k] = any ? s : null
    })
    const sum = (f) => parts.reduce((a, p) => a + (p[f] || 0), 0)
    return { monthly, fyBudget: sum('fyBudget'), ytdActual: sum('ytdActual'), ytdBudget: sum('ytdBudget'), ytdVar: sum('ytdVar') }
  }

  const headline = {
    totalIncome: line(/^total income/i),
    totalOpEx: line(/^total operating expense/i),
    noi: line(/^net operating income/i),
    noiAR: line(/^noi after replacement/i)
  }

  const catLines = {
    '51599-099': line(/^payroll/i),
    '53999-099': sumLines(/^repairs/i, /^make-ready/i, /^contract services/i),
    '54999-099': line(/^advertising/i),
    '58399-099': sumLines(/^office expense/i, /^other g&a/i),
    '59999-099': line(/^utilities/i),
    '61999-099': line(/^management fee/i),
    '62999-099': line(/^taxes/i),
    '63999-099': line(/^insurance/i)
  }

  // Monthly scorecard from the Monthly Phasing sheet
  const scorecard = { income: null, opex: null, noi: null, noiAR: null }
  const phName = wb.SheetNames.find(n => /monthly phasing/i.test(n))
  if (phName) {
    const pw = XLSX.utils.sheet_to_json(wb.Sheets[phName], { header: 1, raw: true })
    let ph = -1
    for (let i = 0; i < 8 && i < pw.length; i++) {
      const c = (pw[i] || []).filter(v => MON.includes(String(v || '').trim().toLowerCase().slice(0, 3))).length
      if (c >= 10) { ph = i; break }
    }
    if (ph >= 0) {
      const pmCol = {}
      ;(pw[ph] || []).forEach((v, ci) => {
        const k = String(v || '').trim().toLowerCase().slice(0, 3)
        if (MON.includes(k) && pmCol[k] == null) pmCol[k] = ci
      })
      const phRow = (re) => {
        for (let r = ph + 1; r < pw.length; r++) {
          if (re.test(String((pw[r] || [])[0] || '').trim())) {
            const o = {}; MON.forEach(k => { o[k] = pmCol[k] != null ? num(pw[r][pmCol[k]]) : null })
            return o
          }
        }
        return null
      }
      const actRow = (re) => {
        for (let r = blockEnd; r < grid.length; r++) {
          if (re.test(String((grid[r] || [])[0] || '').trim())) {
            const o = {}
            MON.forEach(k => { const v = monCol[k] != null ? num(grid[r][monCol[k]]) : null; o[k] = (v == null || v === 0) ? null : v })
            return o
          }
        }
        return null
      }
      const keys = ['income', 'opex', 'noi', 'noiAR']
      const budRegs = [/^total income/i, /^total operating expense/i, /^net operating income/i, /^noi after replacement/i]
      keys.forEach((k, i) => { scorecard[k] = { budget: phRow(budRegs[i]), actual: actRow(budRegs[i]) } })

      const sumPhRows = (...res) => {
        const parts = res.map(re => phRow(re)).filter(Boolean)
        if (!parts.length) return null
        const o = {}; MON.forEach(k => { let s = 0, any = false; parts.forEach(p => { if (p[k] != null) { s += p[k]; any = true } }); o[k] = any ? s : null })
        return o
      }
      const sumActRows = (...res) => {
        const parts = res.map(re => actRow(re)).filter(Boolean)
        if (!parts.length) return null
        const o = {}; MON.forEach(k => { let s = 0, any = false; parts.forEach(p => { if (p[k] != null) { s += p[k]; any = true } }); o[k] = any ? s : null })
        return o
      }
      scorecard.catByMonth = {}
      const catDefs = [
        ['51599-099', () => phRow(/^payroll/i), () => actRow(/^payroll/i)],
        ['53999-099', () => sumPhRows(/^repairs/i, /^make-ready/i, /^contract services/i), () => sumActRows(/^repairs/i, /^make-ready/i, /^contract services/i)],
        ['54999-099', () => phRow(/^advertising/i), () => actRow(/^advertising/i)],
        ['58399-099', () => sumPhRows(/^office expense/i, /^other g&a/i), () => sumActRows(/^office expense/i, /^other g&a/i)],
        ['59999-099', () => phRow(/^utilities/i), () => actRow(/^utilities/i)],
        ['61999-099', () => phRow(/^management fee/i), () => actRow(/^management fee/i)],
        ['62999-099', () => phRow(/^taxes/i), () => actRow(/^taxes/i)],
        ['63999-099', () => phRow(/^insurance/i), () => actRow(/^insurance/i)]
      ]
      catDefs.forEach(([code, bf, af]) => { scorecard.catByMonth[code] = { budget: bf(), actual: af() } })
    }
  }

  return {
    sheetName, monthOrder: MON, closedMonths,
    currentMonth: closedMonths.length ? closedMonths[closedMonths.length - 1] : null,
    headline, catLines, scorecard
  }
}
