// Maps Entrata API rent-roll report rows -> the SAME normalized shape produced by
// lib/entrata-rr-parser.js (the spreadsheet parser). Output drops straight into
// the rent_roll_snapshots table, so nothing downstream changes.
//
// Keep ALL Entrata-field-name assumptions in this file. Once we see a real API
// response, the only edits should be the field-key lookups in pick() calls below
// (each marked CONFIRM).

function num(v) {
  if (v == null || v === '') return null
  const n = parseFloat(String(v).replace(/[$,]/g, ''))
  return isNaN(n) ? null : n
}

// Same tier thresholds as entrata-rr-parser.js — kept in sync intentionally.
function tierOf(sf) {
  if (sf == null || isNaN(sf)) return 'Unknown'
  if (sf <= 610) return 'Small (<=610 SF)'
  if (sf <= 950) return '1 Bedroom'
  if (sf <= 1310) return '2 Bedroom'
  return 'Large 2BR / 3BR'
}

function toISODate(v) {
  if (!v) return ''
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

// Read the first present key from a row (Entrata field names vary by report version).
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') return row[k]
  }
  return null
}

// rows: array of report row objects from runReport(); asOf: 'YYYY-MM-DD'
export function mapEntrataRR(rows, asOf) {
  if (!Array.isArray(rows)) return { error: 'Entrata rent-roll report returned no rows' }

  const units = rows.map(row => {
    // CONFIRM each key list against the live report's column names.
    const unit     = pick(row, ['Unit', 'BldgUnit', 'unit', 'unitNumber'])
    const utype    = pick(row, ['UnitType', 'unitType', 'FloorPlan']) || ''
    const sqft     = num(pick(row, ['SQFT', 'SquareFeet', 'sqft']))
    const status   = String(pick(row, ['UnitStatus', 'Status', 'status']) || '').trim()
    const resident = String(pick(row, ['Resident', 'ResidentName', 'Name']) || '').trim()
    const moveIn   = toISODate(pick(row, ['MoveIn', 'MoveInDate', 'moveIn']))
    const leaseEnd = toISODate(pick(row, ['LeaseEnd', 'LeaseExpiration', 'LeaseExpire']))
    const market   = num(pick(row, ['MarketRent', 'Market', 'marketRent']))
    const sched    = num(pick(row, ['ScheduledCharges', 'ScheduledRent', 'ActualRent', 'Rent']))

    const isVacant    = /^vacant/i.test(status) || !resident
    const isPreLeased = isVacant && /rented|pre.?leased|applicant/i.test(status)
    const inplace     = isVacant ? null : sched
    const inplaceReview = !isVacant && inplace == null

    return {
      unit, utype, sqft,
      tier: tierOf(sqft),
      vacant: isVacant, preLeased: isPreLeased,
      market, inplace, inplaceReview, fees: 0,
      leaseExp: leaseEnd, moveIn,
      name: isVacant ? 'VACANT' : resident,
      residentId: '',
    }
  }).filter(u => u.unit) // drop subtotal / blank rows

  return {
    asOf,
    units,
    skipped: 0,
    dupCount: 0,
    preleasedVacant: units.filter(u => u.vacant && u.preLeased).length,
    reviewCount: units.filter(u => u.inplaceReview).length,
  }
}
