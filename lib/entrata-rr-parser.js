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

export function parseEntrataRR(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })

  // As-of date: scan first 8 rows
  let asOf = ''
  for (let i = 0; i < Math.min(8, grid.length) && !asOf; i++) {
    for (const cell of (grid[i] || [])) {
      if (cell instanceof Date && !isNaN(cell)) { asOf = toISODate(cell); break }
      const m = String(cell || '').match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/)
      if (m) { asOf = m[1]; break }
    }
  }

  // Header row: has "Unit" or "Unit #" AND a rent or market column
  let hdrRow = -1
  for (let i = 0; i < Math.min(20, grid.length); i++) {
    const row = (grid[i] || []).map(v => String(v || '').trim())
    const hasUnit = row.some(v => /^unit\s*#?$|^unit\s*number$/i.test(v))
    const hasRent = row.some(v => /rent|charge|market/i.test(v))
    if (hasUnit && hasRent) { hdrRow = i; break }
  }
  if (hdrRow < 0) return { error: 'Could not find header row — is this an Entrata Rent Roll export?' }

  const hdr = (grid[hdrRow] || []).map(v => String(v || '').toLowerCase().trim())
  const col = re => hdr.findIndex(v => re.test(v))

  const cUnit     = col(/^unit\s*#?$|^unit\s*number$/)
  const cType     = col(/^(unit\s+)?type$|^floor\s*plan$/)
  const cSqft     = col(/^sq\.?\s*ft\.?$|^sqft$|^size(\s*\(sf\))?$/)
  const cStatus   = col(/^status$/)
  const cName     = col(/^(resident\s+)?name$|^resident$|^tenant$/)
  const cMoveIn   = col(/^move[\s-]?in(\s+date)?$/)
  const cLeaseEnd = col(/^lease\s*(end|exp\b|expir)/)
  const cMarket   = col(/^market\s*rent$|^market$/)

  // In-place rent: prefer specificity (lease rent > current rent > scheduled > contract > rent)
  let cRent = col(/^lease\s+rent$/)
  if (cRent < 0) cRent = col(/^current\s+rent$/)
  if (cRent < 0) cRent = col(/^scheduled\s+(rent|charges?)$/)
  if (cRent < 0) cRent = col(/^contract\s+rent$/)
  if (cRent < 0) cRent = col(/^rent$/)

  if (cUnit < 0) return { error: 'Could not locate Unit column in Entrata rent roll' }

  const units = []
  for (let r = hdrRow + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const unitId = String(row[cUnit] || '').trim()
    if (!unitId || /^total|^grand\s*total/i.test(unitId)) continue

    const utype = cType >= 0 ? String(row[cType] || '').trim() : ''
    if (!utype) continue

    const sqft      = cSqft >= 0 ? num(row[cSqft]) : null
    const statusRaw = cStatus >= 0 ? String(row[cStatus] || '').trim() : ''
    const name      = cName >= 0 ? String(row[cName] || '').trim() : ''
    const market    = cMarket >= 0 ? num(row[cMarket]) : null
    const rent      = cRent >= 0 ? num(row[cRent]) : null
    const moveIn    = cMoveIn >= 0 ? toISODate(row[cMoveIn]) : ''
    const leaseEnd  = cLeaseEnd >= 0 ? toISODate(row[cLeaseEnd]) : ''

    const isVacant    = /^(vacant|available|down|model|admin|notice)/i.test(statusRaw)
                     || !name || name.toUpperCase() === 'VACANT'
    const isPreLeased = /pre.?leas/i.test(statusRaw)

    const inplace       = isVacant ? null : rent
    const inplaceReview = !isVacant && inplace == null

    units.push({
      unit: unitId, utype, sqft,
      tier: tierOf(sqft),
      vacant: isVacant,
      preLeased: isVacant && isPreLeased,
      market, inplace, inplaceReview, fees: 0,
      leaseExp: leaseEnd, moveIn,
      name: isVacant ? 'VACANT' : name,
      residentId: '',
    })
  }

  const preleasedVacant = units.filter(u => u.vacant && u.preLeased).length
  return {
    asOf, units,
    skipped: 0, dupCount: 0,
    preleasedVacant,
    reviewCount: units.filter(u => u.inplaceReview).length,
  }
}
