import * as XLSX from 'xlsx'

function num(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[$,]/g, ''))
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

const MONTH_MAP = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' }

export function parseEntrataRR(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })

  // As-of date: Entrata puts "Apr 2026" in row 2, col A
  let asOf = ''
  for (let i = 0; i < Math.min(6, grid.length) && !asOf; i++) {
    const s = String(grid[i]?.[0] || '').trim()
    const m = s.match(/^([A-Za-z]{3,})\s+(\d{4})$/)
    if (m) {
      const mo = MONTH_MAP[m[1].toLowerCase().slice(0, 3)]
      if (mo) { asOf = m[2] + '-' + mo + '-01'; break }
    }
    const m2 = s.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/)
    if (m2) { asOf = m2[1]; break }
  }

  // Header row: col A = "Bldg-Unit" or "Unit", col B = "SQFT"
  let hdrRow = -1
  for (let i = 0; i < Math.min(10, grid.length); i++) {
    const row = grid[i] || []
    if (/bldg.?unit|^unit$/i.test(String(row[0] || '')) &&
        /^sqft$|^sq\.?\s*ft/i.test(String(row[1] || ''))) {
      hdrRow = i; break
    }
  }
  if (hdrRow < 0) return { error: 'Could not find header row — is this an Entrata Rent Roll export?' }

  const hdr = (grid[hdrRow] || []).map(v => String(v || '').toLowerCase().trim())
  const findCol = re => hdr.findIndex(v => re.test(v))

  const cUnit    = findCol(/bldg.?unit|^unit$/)
  const cSqft    = findCol(/^sqft$|^sq\.?\s*ft/)
  const cStatus  = findCol(/unit status|^status$/)
  const cRes     = findCol(/^resident$|^name$/)
  const cMoveIn  = findCol(/^move.?in/)
  const cLeaseEnd = findCol(/^lease end|^lease expir/)
  const cMarket  = findCol(/^market rent$/)
  const cSched   = findCol(/^scheduled charges?$/)

  const today = new Date()
  const allBeds = []
  let curType = ''

  for (let r = hdrRow + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const cellA = String(row[0] || '').trim()

    if (/^unit type:/i.test(cellA)) {
      curType = cellA.replace(/^unit type:\s*/i, '').trim()
      continue
    }
    // Stop at the summary statistics block that follows unit data
    if (/summary/i.test(cellA)) break
    if (!cellA || /total:?\s*$/i.test(cellA)) continue

    const bed      = cellA
    const sqft     = cSqft >= 0 ? num(row[cSqft]) : null
    const status   = cStatus >= 0 ? String(row[cStatus] || '').trim() : ''
    const resident = cRes >= 0 ? String(row[cRes] || '').trim() : ''
    const moveIn   = cMoveIn >= 0 ? toISODate(row[cMoveIn]) : ''
    const leaseEnd = cLeaseEnd >= 0 ? toISODate(row[cLeaseEnd]) : ''
    const market   = cMarket >= 0 ? num(row[cMarket]) : null
    const sched    = cSched >= 0 ? num(row[cSched]) : null

    // Future lease row: move-in is after today
    const moveInDate = moveIn ? new Date(moveIn + 'T12:00:00') : null
    const isFuture = !!(moveInDate && moveInDate > today)

    allBeds.push({ bed, utype: curType, sqft, status, resident, moveIn, leaseEnd, market, sched, isFuture })
  }

  // Build set of beds that have a signed future lease
  const futureByBed = new Set(allBeds.filter(b => b.isFuture).map(b => b.bed))

  // Dedupe current beds — take first (earliest) occurrence per bed ID
  const byBed = {}
  allBeds.filter(b => !b.isFuture).forEach(b => { if (!byBed[b.bed]) byBed[b.bed] = b })

  let preleasedVacant = 0
  const units = Object.values(byBed).map(b => {
    const isVacant    = /^vacant/i.test(b.status) || !b.resident
    const isPreLeased = isVacant && (futureByBed.has(b.bed) || /rented/i.test(b.status))
    if (isVacant && isPreLeased) preleasedVacant++

    const inplace       = isVacant ? null : b.sched
    const inplaceReview = !isVacant && inplace == null

    return {
      unit: b.bed, utype: b.utype, sqft: b.sqft,
      tier: tierOf(b.sqft),
      vacant: isVacant, preLeased: isPreLeased,
      market: b.market, inplace, inplaceReview, fees: 0,
      leaseExp: b.leaseEnd, moveIn: b.moveIn,
      name: isVacant ? 'VACANT' : b.resident,
      residentId: '',
    }
  })

  return {
    asOf, units,
    skipped: 0, dupCount: 0,
    preleasedVacant,
    reviewCount: units.filter(u => u.inplaceReview).length,
  }
}

