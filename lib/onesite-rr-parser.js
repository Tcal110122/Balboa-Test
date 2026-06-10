import * as XLSX from 'xlsx'

function num(v) {
  if (v == null || v === '' || v === '*') return null
  const s = String(v).replace(/,/g, '').replace(/^\((.+)\)$/, '-$1').trim()
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

function tierOf(sf) {
  if (sf == null || isNaN(sf)) return 'Unknown'
  if (sf <= 610) return 'Small (<=610 SF)'
  if (sf <= 950) return '1 Bedroom'
  if (sf <= 1310) return '2 Bedroom'
  return 'Large 2BR / 3BR'
}

function toISODate(v) {
  if (!v) return ''
  const s = String(v).replace(/[\r\n]/g, ' ').trim()
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0')
  return ''
}

export function parseOneSiteRR(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })

  // As-of date: scan first 10 rows for any MM/DD/YYYY
  let asOf = ''
  for (let i = 0; i < Math.min(10, grid.length) && !asOf; i++) {
    for (const cell of (grid[i] || [])) {
      const m = String(cell || '').match(/(\d{1,2}\/\d{1,2}\/\d{4})/)
      if (m) { asOf = m[1]; break }
    }
  }

  // Header row: col 0 = "Unit", col 2 = "Floorplan"
  let hdrRow = -1
  for (let i = 0; i < Math.min(15, grid.length); i++) {
    const row = grid[i] || []
    if (/unit/i.test(String(row[0])) && /floorplan/i.test(String(row[2]))) {
      hdrRow = i; break
    }
  }
  if (hdrRow < 0) return { error: 'Could not find header row — is this a OneSite Rent Roll Detail?' }

  const rawUnits = []
  let cur = null
  let inFuture = false  // true while parsing pending-renewal / applicant sub-rows

  for (let i = hdrRow + 1; i < grid.length; i++) {
    const row = grid[i] || []
    const col0  = String(row[0]  || '').trim()
    const col2  = String(row[2]  || '').trim()
    const col17 = String(row[17] || '').trim()
    const col35 = String(row[35] || '').trim().toLowerCase()

    // Skip page-break separators and repeated header rows
    if (col0 === 'details' && !col2) continue
    if (/^unit$/i.test(col0) && /^floorplan$/i.test(col2)) continue

    if (col0 && col2) {
      // New unit header row
      cur = {
        unit:      col0,
        utype:     col2,
        sqft:      num(row[13]),
        status:    col17,
        name:      String(row[19] || '').trim(),
        moveIn:    toISODate(String(row[23] || '')),
        leaseEnd:  toISODate(String(row[29] || '')),
        market:    num(row[32]),
        rentLines: [],
      }
      inFuture = false
      rawUnits.push(cur)
    } else if (cur) {
      // Sub-row: detect future-lease context
      if (/pending renewal|applicant/i.test(col17)) inFuture = true
      // Only capture RENT lines for the current occupant
      if (!inFuture && col35 === 'rent') {
        const v = num(row[42])
        if (v != null && v > 0) cur.rentLines.push(v)
      }
    }
  }

  let preleasedVacant = 0
  const units = rawUnits.map(u => {
    if (!u.utype || u.sqft == null) return null
    const isVac      = !u.name || u.name.toUpperCase() === 'VACANT'
    const isPreLeased = /vacant-leased/i.test(u.status)
    if (isPreLeased) preleasedVacant++

    let inplace = null, inplaceReview = false
    if (!isVac && u.rentLines.length) {
      inplace = u.rentLines.reduce((a, b) => a + b, 0)
      // market includes fees so use a relaxed lower bound
      if (u.market && (inplace < 0.45 * u.market || inplace > 1.25 * u.market)) inplaceReview = true
    }

    return {
      unit: u.unit, utype: u.utype, sqft: u.sqft, tier: tierOf(u.sqft),
      vacant: isVac, market: u.market,
      inplace, inplaceReview, fees: 0,
      leaseExp: u.leaseEnd, moveIn: u.moveIn,
      name: u.name, preLeased: isPreLeased, residentId: '',
    }
  }).filter(Boolean)

  return { asOf, units, skipped: rawUnits.length - units.length, dupCount: 0, preleasedVacant }
}

