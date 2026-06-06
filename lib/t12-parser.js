import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }

const MON_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function mmddyyyyToLabel(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/)
  return m ? MON_NAMES[parseInt(m[1], 10) - 1] + ' ' + m[2] : null
}

function parseT12Data(grid) {
  let hdrRow = -1, bestCount = 0
  for (let i = 0; i < 14 && i < grid.length; i++) {
    const row = grid[i] || []
    const cnt = row.filter(v => {
      const s = String(v || '').trim()
      return /^[A-Za-z]{3,}\s+\d{4}$/.test(s) || /^\d{1,2}\/\d{2}\/\d{4}$/.test(s)
    }).length
    if (cnt > bestCount) { bestCount = cnt; hdrRow = i }
  }
  if (hdrRow < 0 || bestCount < 2) return { error: 'Could not find the month header row — is this a Yardi T-12?' }

  const months = []
  ;(grid[hdrRow] || []).forEach((v, ci) => {
    const s = String(v || '').trim()
    if (/^[A-Za-z]{3,}\s+\d{4}$/.test(s)) months.push({ ci, label: s })
    else { const lbl = mmddyyyyToLabel(s); if (lbl) months.push({ ci, label: lbl }) }
  })

  let totalCi = -1
  // Check hdrRow and the row above it (some formats put "12-Month Total" one row above dates)
  for (let rr = Math.max(0, hdrRow - 1); rr <= hdrRow; rr++) {
    ;(grid[rr] || []).forEach((v, ci) => {
      if (/^(total|12.?month total)$/i.test(String(v || '').trim())) totalCi = ci
    })
  }

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

  // Strip "XXXX - " account-code prefix so regexes match labels in any Yardi format
  const stripAcct = s => s.replace(/^[\d][\d-]*\s+-\s+/, '')

  const findRow = (re) => {
    for (let r = hdrRow + 1; r < grid.length; r++) {
      for (let ci = 0; ci < 6; ci++) {
        const raw = String((grid[r] || [])[ci] || '').trim()
        if (re.test(raw) || re.test(stripAcct(raw))) {
          const d = readRow(r)
          if (d.total != null || d.vals.some(v => v != null)) return r
          break
        }
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

  // figMany: finds ALL rows matching any regex in the array and sums them.
  // Used for categories that have multiple sub-category subtotal rows (e.g. maintenance).
  const figMany = (acct, label, reArray) => {
    const found = []
    const seenRows = new Set()
    const primary = byAcct[acct]
    if (primary != null) { found.push(readRow(primary)); seenRows.add(primary) }
    for (const re of reArray) {
      for (let r = hdrRow + 1; r < grid.length; r++) {
        if (seenRows.has(r)) continue
        for (let ci = 0; ci < 6; ci++) {
          const raw = String((grid[r] || [])[ci] || '').trim()
          if (re.test(raw) || re.test(stripAcct(raw))) {
            const d = readRow(r)
            if (d.total != null || d.vals.some(v => v != null)) { found.push(d); seenRows.add(r) }
            break
          }
        }
      }
    }
    if (!found.length) return null
    const vals = months.map((_, i) => found.reduce((s, d) => d.vals[i] != null ? s + d.vals[i] : s, 0) || null)
    const total = vals.reduce((s, v) => v != null ? s + v : s, 0)
    return { label, acct, row: -1, vals, total }
  }

  const totalIncome  = fig('49999-999', 'Total Income',            /^(total (income|revenue)|effective gross income|egi|total revenue)\s*$/i)
  const totalOpEx    = fig('66999-199', 'Total Operating Expenses', /^(total (operating )?expens(es?)?|operating expenses?|total expenses?)\s*$/i)
  const noi          = fig('69999-099', 'Net Operating Income',    /^(net operating income\/?(\(loss\))?|net income|noi)\s*$/i)
  let   noiAfterRepl = fig('71999-099', 'NOI After Replacements',  /^noi after (repl|res)/i)
  // Prefer TOTAL GPA (adjusted) over Gross Potential Rent (unadjusted) when both exist
  const potentialRent =
    fig('41029-099', 'Potential Rent', /^total gpa\s*$/i) ||
    fig('41029-099', 'Potential Rent', /^(potential( gross)? rent|gross potential( rent)?|gross possible( rent)?|scheduled rent|total possible rent|total net rent)\s*$/i)

  const maintRe = [
    /^(total )?(general maintenance|repairs?\s*&\s*maint(enance)?|maintenance(\s*&?\s*repair)?)\s*$/i,
    /^(total )?painting(\s*(&|and)\s*decorat(ing)?)?\s*$/i,
    /^(total )?contracted?\s*services?\s*$/i,
    /^(total )?contract\s*services?\s*$/i,
  ]
  const expenseCats = [
    ['51599-099', 'Payroll & Benefits',       /^(total )?(payroll(\s*&\s*benefits|\s+expense)?|salaries(\s+expense)?)\s*$/i],
    ['54999-099', 'Advertising / Marketing',  /^total\s+(advertising(\s*([/&]|and)\s*(promotion|marketing))?|marketing)(\s+expenses?)?\s*$/i],
    ['58399-099', 'General & Administrative', /^(total )?(general(\s*&\s*|\s+)admin(istrative)?|administrative(\s+expense)?)\s*$/i],
    ['59999-099', 'Utilities',                /^(total )?utilities\s*$/i],
    ['61999-099', 'Management Fees',          /^(total )?management fees?\s*$/i],
    ['62999-099', 'Taxes',                    /^(total )?(real estate tax(es?)?|property tax(es?)?|tax(es?)?(\s+expense)?)\s*$/i],
  ]
  const insurRe = [
    /^(total )?insurance(\s+expense)?\s*$/i,
    /^(property\s*(&|and)\s*liability\s*)?insurance\s*$/i,
    /^flood\s*insurance\s*$/i,
  ]
  const maint = figMany('53999-099', 'General Maintenance', maintRe)
  const insur  = figMany('63999-099', 'Insurance', insurRe)
  const categories = [
    maint ? { ...maint, name: 'General Maintenance' } : null,
    insur  ? { ...insur,  name: 'Insurance' }          : null,
    ...expenseCats.map(([acct, name, re]) => {
      const f = fig(acct, name, re)
      return f ? { ...f, name } : null
    })
  ].filter(Boolean)

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
    // Try to derive NOI After Replacements from capital/renovation rows.
    // These rows may be positive (expense section) or negative (balance-sheet items)
    // — take absolute values so they are always deducted from NOI.
    const replRe = [
      /^total\s+inter[io]+r\s*[&]?\s*exterior\s+renovations?\s*$/i,  // TOTAL INTERIOR & EXTERIOR RENOVATIONS
      /^total\s+exterior\s+improvements?\s*$/i,
      /^total\s+interior\s+improvements?\s*$/i,
      /^total\s+(routine\s+)?replacements?\s*$/i,
      /^(total )?capital\s+(replacements?|improvements?)\s*$/i,
    ]
    const replParts = replRe.map(re => {
      const r = findRow(re)
      if (r == null) return null
      const d = readRow(r)
      return { vals: d.vals.map(v => v == null ? null : Math.abs(v)), total: Math.abs(d.total || 0) }
    }).filter(Boolean)

    if (replParts.length > 0) {
      const replVals = months.map((_, i) => replParts.reduce((s, p) => s + (p.vals[i] || 0), 0))
      const replTotal = replParts.reduce((s, p) => s + p.total, 0)
      noiAfterRepl = {
        label: 'NOI After Replacements', acct: 'computed', row: -1,
        vals: noi.vals.map((v, i) => v != null ? v - replVals[i] : null),
        total: noi.total - replTotal
      }
    } else {
      // Legacy fallback: add back interest expense (only for formats where that makes sense)
      const interest = fig('6801-0000', 'Interest Expense')
      if (interest) {
        const vals = noi.vals.map((v, i) => v != null ? v + (interest.vals[i] || 0) : null)
        noiAfterRepl = { label: 'NOI After Replacements', acct: 'computed', row: -1,
          vals, total: (noi.total || 0) + (interest.total || 0) }
      }
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

  // Other Rental Inc: sum the "Less:" adjustment rows (concessions, vacancy, write-offs, employee)
  const otherRentalIncRe = [
    /^less:?\s*concessions?/i,
    /^less:?\s*vacancy/i,
    /^less:?\s*write.?offs?/i,
    /^less:?\s*employee rent concession/i,
    /^(total )?(other rental (income|inc\.?)|rental losses?)\s*$/i,
  ]
  const otherRentalIncFig = figMany('41999-098', 'Total Other Rental Inc.', otherRentalIncRe)

  // Other Income: derive as Total Income − Potential Rent − Other Rental Inc when possible
  let otherIncFig = fig('43599-099', 'Total Other Income', /^(total )?other income\s*$/i)
  if (totalIncome && potentialRent && otherRentalIncFig) {
    const vals = totalIncome.vals.map((v, i) =>
      v != null ? v - (potentialRent.vals[i] || 0) - (otherRentalIncFig.vals[i] || 0) : null
    )
    otherIncFig = { label: 'Total Other Income', acct: '43599-099', vals, total: totalIncome.total - potentialRent.total - otherRentalIncFig.total }
  }

  const incomeLines = [
    fig('41029-099', 'Potential Rent', /^total gpa\s*$/i) ||
    fig('41029-099', 'Potential Rent', /^(potential( gross)? rent|gross potential( rent)?|gross possible( rent)?|scheduled rent|total possible rent|total net rent)\s*$/i),
    otherRentalIncFig,
    otherIncFig,
    fig('42099-099', 'Total Corporate Housing', /^(total )?corporate housing\s*$/i),
  ].filter(Boolean)

  let period = ''
  for (let i = 0; i < 10 && !period; i++) {
    const v = String((grid[i] || [])[0] || '').trim()
    if (/\w+ \d{4}\s*[-–]\s*\w+ \d{4}/.test(v) || /period\s*=/i.test(v)) {
      period = v.replace(/period\s*=\s*/i, '').trim()
    } else if (/as of date/i.test(v)) {
      const dateCell = String((grid[i] || [])[1] || '').trim()
      const lbl = mmddyyyyToLabel(dateCell)
      period = lbl || dateCell
    }
  }
  // Derive period from months array if not found elsewhere
  if (!period && months.length) {
    const last = months[months.length - 1].label, first = months[0].label
    period = last !== first ? last + ' – ' + first : last
  }

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
