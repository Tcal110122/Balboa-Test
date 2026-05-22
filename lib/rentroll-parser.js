import * as XLSX from 'xlsx'

const FEE_CODES = new Set([
  'internet','trashrb','liabins','carport','utilreim','garage',
  'trash-pu','petrent','pestrb','empdisc','patrol','pestctrl'
])

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }

function tierOf(sf) {
  if (sf == null || isNaN(sf)) return 'Unknown'
  if (sf <= 610) return 'Small (<=610 SF)'
  if (sf <= 950) return '1 Bedroom'
  if (sf <= 1310) return '2 Bedroom'
  return 'Large 2BR / 3BR'
}

function toISODate(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getUTCFullYear(), m = v.getUTCMonth() + 1, d = v.getUTCDate()
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  }
  if (typeof v === 'number' && v > 0) {
    const dt = new Date(Math.round((v - 25569) * 86400 * 1000))
    if (!isNaN(dt)) return dt.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0')
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) {
    let yr = m[3]; if (yr.length === 2) yr = '20' + yr
    return yr + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0')
  }
  return ''
}

function parseRows(rows) {
  let asOf = ''
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    const c = (rows[i] && rows[i][0]) ? String(rows[i][0]) : ''
    if (c.toLowerCase().startsWith('as of')) {
      const m = c.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/)
      if (m) asOf = m[1]
    }
  }

  // Auto-detect rent code: find the most common non-fee positive charge in col G/H.
  // Handles any PM system (Yardi uses 'rent'; Entrata may use something else).
  const KNOWN_RENT = new Set(['rent','base rent','lease rent','contract rent','unit rent'])
  const codeCounts = {}
  for (const row of rows) {
    const code = row[6] == null ? '' : String(row[6]).trim().toLowerCase()
    const amt = num(row[7])
    if (code && code !== 'total' && !FEE_CODES.has(code) && amt != null && amt > 0)
      codeCounts[code] = (codeCounts[code] || 0) + 1
  }
  const topUnknown = Object.entries(codeCounts)
    .filter(([c]) => !KNOWN_RENT.has(c))
    .sort((a, b) => b[1] - a[1])[0]
  if (topUnknown && topUnknown[1] >= 3) KNOWN_RENT.add(topUnknown[0])

  const units = []; let cur = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || []
    const [A, B, C, D, E, F, G, H] = row
    const K = row[10], L = row[11], M = row[12]
    const aStr = A == null ? '' : String(A).trim()
    const isHeaderWord = /^(unit|current|month|as of|rent roll|total)$/i.test(aStr)
    const looksUnit = aStr.length > 0 && !isHeaderWord && B != null && String(B).trim() !== ''

    if (looksUnit) {
      cur = {
        unit: aStr, utype: String(B).trim(), sqft: num(C),
        name: E == null ? '' : String(E).trim(),
        residentId: D == null ? '' : String(D).trim(),
        market: num(F),
        rentlines: [], fees: 0, total: null,
        moveIn: toISODate(K), leaseExp: toISODate(L), moveOut: toISODate(M),
        rowIndex: i
      }
      units.push(cur)
    } else if (cur) {
      const code = G == null ? '' : String(G).trim().toLowerCase()
      const amt = num(H)
      if (code === 'total' && amt != null) cur.total = amt
      else if (KNOWN_RENT.has(code) && amt != null) cur.rentlines.push(amt)
      else if (FEE_CODES.has(code) && amt != null) cur.fees += amt
    }
  }

  const built = []
  units.forEach(u => {
    if (!u.utype || u.sqft == null) return
    const isVac = u.name.toUpperCase() === 'VACANT' || u.name === ''
    let base = null, review = false
    if (!isVac) {
      if (u.rentlines.length) {
        base = u.rentlines.reduce((a, b) => a + b, 0)
      } else if (u.total != null) {
        base = u.total - u.fees
        if (u.fees < 0) review = true
        if (u.market != null && (base < 0.55 * u.market || base > 1.25 * u.market)) review = true
        if (base <= 0) { base = null; review = true }
      } else { review = true }
    }
    built.push({
      unit: u.unit, utype: u.utype, sqft: u.sqft, tier: tierOf(u.sqft),
      vacant: isVac, market: u.market,
      inplace: base, inplaceReview: review,
      fees: u.fees, leaseExp: u.leaseExp, moveIn: u.moveIn, moveOut: u.moveOut,
      residentId: u.residentId, name: u.name, rowIndex: u.rowIndex
    })
  })

  const byUnit = {}
  built.forEach(u => { if (!byUnit[u.unit]) byUnit[u.unit] = []; byUnit[u.unit].push(u) })

  const clean = []; let dupCount = 0, preleased = 0
  Object.values(byUnit).forEach(recs => {
    recs.sort((a, b) => a.rowIndex - b.rowIndex)
    const current = recs[0]
    if (recs.length > 1) {
      dupCount += recs.length - 1
      current.preLeased = true
      const future = recs[recs.length - 1]
      current.futureLeaseExp = future.leaseExp || ''
      if (current.vacant) preleased++
    } else {
      current.preLeased = false
    }
    delete current.rowIndex
    clean.push(current)
  })

  return {
    asOf,
    units: clean,
    skipped: units.length - built.length,
    dupCount,
    preleasedVacant: preleased,
    reviewCount: clean.filter(u => u.inplaceReview).length
  }
}

export function parseRentRoll(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  return parseRows(rows)
}
