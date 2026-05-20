import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }

function parseT12Data(grid) {
  let hdrRow = -1, bestCount = 0
  for (let i = 0; i < 14 && i < grid.length; i++) {
    const row = grid[i] || []
    const cnt = row.filter(v => /^[A-Za-z]{3,}\s+\d{4}$/.test(String(v || '').trim())).length
    if (cnt > bestCount) { bestCount = cnt; hdrRow = i }
  }
  if (hdrRow < 0 || bestCount < 2) return { error: 'Could not find the month header row — is this a Yardi T-12?' }

  const months = []
  ;(grid[hdrRow] || []).forEach((v, ci) => {
    const s = String(v || '').trim()
    if (/^[A-Za-z]{3,}\s+\d{4}$/.test(s)) months.push({ ci, label: s })
  })

  let totalCi = -1
  ;(grid[hdrRow] || []).forEach((v, ci) => {
    if (/^total$/i.test(String(v || '').trim())) totalCi = ci
  })

  const readRow = (r) => {
    const row = grid[r] || []
    const vals = months.map(m => num(row[m.ci]))
    const tot = totalCi >= 0 ? num(row[totalCi]) : vals.reduce((a, b) => a + (b || 0), 0)
    return { vals, total: tot }
  }

  const byAcct = {}
  grid.forEach((row, r) => {
    const a = String((row || [])[0] || '').trim()
    if (a) byAcct[a] = r
  })

  const findRow = (re) => {
    for (let r = hdrRow + 1; r < grid.length; r++) {
      for (let ci = 0; ci < 6; ci++) {
        if (re.test(String((grid[r] || [])[ci] || '').trim())) return r
      }
    }
    return null
  }

  const fig = (acct, label, re) => {
    let r = byAcct[acct]
    if (r == null && re) r = findRow(re)
    if (r == null) return null
    const d = readRow(r)
    return { label, acct, row: r, vals: d.vals, total: d.total }
  }

  const totalIncome  = fig('49999-999', 'Total Income',            /^(total income|effective gross income|egi)/i)
  const totalOpEx    = fig('66999-199', 'Total Operating Expenses', /^total oper/i)
  const noi          = fig('69999-099', 'Net Operating Income',    /^net operating income/i)
  let   noiAfterRepl = fig('71999-099', 'NOI After Replacements',  /^noi after (repl|res)/i)
  const potentialRent = fig('41029-099', 'Potential Rent',         /^potential rent/i)

  const expenseCats = [
    ['51599-099', 'Payroll & Benefits',       /^payroll/i],
    ['53999-099', 'General Maintenance',      /^(general maintenance|repairs? & maint)/i],
    ['54999-099', 'Advertising / Marketing',  /^(advertising|marketing)/i],
    ['58399-099', 'General & Administrative', /^general.{0,5}admin/i],
    ['59999-099', 'Utilities',                /^utilities$/i],
    ['61999-099', 'Management Fees',          /^management fee/i],
    ['62999-099', 'Taxes',                    /^taxes?$/i],
    ['63999-099', 'Insurance',                /^insurance$/i]
  ]
  const categories = expenseCats.map(([acct, name, re]) => {
    const f = fig(acct, name, re)
    return f ? { ...f, name } : null
  }).filter(Boolean)

  const subCats = {
    '53999-099': [
      ['52299-099', 'Repairs & Maintenance'],
      ['52799-099', 'Make-Ready / Redecorating'],
      ['52999-099', 'Recreational Amenities'],
      ['53298-099', 'Contract Services']
    ],
    '58399-099': [
      ['58199-099', 'Office Expenses'],
      ['58398-099', 'Other General & Administrative']
    ]
  }

  const belowNOI = [
    ['71499-099', 'Routine Replacement',  /^routine repl/i],
    ['71899-099', 'Capital / Renovation', /^(capital|renovation)/i]
  ].map(([acct, name, re]) => { const f = fig(acct, name, re); return f ? { ...f, name } : null }).filter(Boolean)
  if (!noiAfterRepl && noi) {
    const interest = fig('6801-0000', 'Interest Expense')
    if (interest) {
      const vals = noi.vals.map((v, i) => v != null ? v + (interest.vals[i] || 0) : null)
      noiAfterRepl = { label: 'NOI After Replacements', acct: 'computed', row: -1,
        vals, total: (noi.total || 0) + (interest.total || 0) }
    }
  }

  const detailFor = (subtotalRow) => {
    const items = []
    for (let r = subtotalRow - 1; r >= 6; r--) {
      const row = grid[r] || []
      const a = String(row[0] || '').trim()
      const nm = String(row[1] || '').trim()
      if (!a && !nm) continue
      if (/^total/i.test(nm)) break
      const d = readRow(r)
      const hasNum = d.vals.some(v => v != null) || d.total != null
      if (!hasNum) break
      items.unshift({ name: nm, acct: a, vals: d.vals, total: d.total })
    }
    return items
  }

  categories.forEach(c => {
    if (subCats[c.acct]) {
      c.items = subCats[c.acct].map(([sa, sn]) => {
        const f = fig(sa, sn)
        return f ? { name: sn, acct: sa, vals: f.vals, total: f.total, isSubtotal: true } : null
      }).filter(Boolean)
      c.nested = true
    } else {
      c.items = detailFor(c.row)
    }
  })
  belowNOI.forEach(c => { c.items = detailFor(c.row) })

  const incomeLines = [
    fig('41029-099', 'Potential Rent'),
    fig('41999-098', 'Total Other Rental Inc.'),
    fig('43599-099', 'Total Other Income'),
    fig('42099-099', 'Total Corporate Housing')
  ].filter(Boolean)

  const period = (grid[2] && grid[2][0]) ? String(grid[2][0]).replace(/period\s*=\s*/i, '').trim() : ''

  return {
    months, period,
    totalIncome, totalOpEx, noi, noiAfterRepl,
    potentialRent, incomeLines,
    categories, belowNOI
  }
}

export function parseT12(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  let mR = 0, mC = 0
  Object.keys(ws).forEach(k => {
    if (k[0] === '!') return
    const c = XLSX.utils.decode_cell(k)
    if (c.r > mR) mR = c.r
    if (c.c > mC) mC = c.c
  })
  if (mR > 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: mR, c: mC } })
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  return parseT12Data(grid)
}
