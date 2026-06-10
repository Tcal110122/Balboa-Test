/**
 * Parser for Yardi "Rent Roll with Lease Charges" Detail (RRD) format.
 *
 * Layout (0-indexed columns):
 *   0  Unit ID          1  Floorplan      7  SQFT
 *   8  Status           11 Name           14 Move-In
 *   16 Lease Start      18 Lease End      20 Market Rent
 *   23 Trans Code text  32 Charge amount  35 Total Billing (unit header row only)
 *
 * The RENT line embeds the dollar amount inside the Trans Code text:
 *   "RENT                                     1,325.00"
 * with col 32 = 0 on that row.
 */

import * as XLSX from 'xlsx'

const C_UNIT = 0, C_FP = 1, C_SQFT = 7, C_STATUS = 8, C_NAME = 11
const C_MOVEIN = 14, C_LEASEEND = 18, C_MARKET = 20
const C_TRANSCODE = 23, C_TOTAL = 35

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
    return y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0')
  }
  if (typeof v === 'number' && v > 0) {
    const dt = new Date(Math.round((v - 25569) * 86400 * 1000))
    if (!isNaN(dt)) return dt.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return m[1] + '-' + m[2].padStart(2,'0') + '-' + m[3].padStart(2,'0')
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { let yr = m[3]; if (yr.length===2) yr='20'+yr; return yr+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0') }
  return ''
}

// Extract rent amount embedded in Trans Code text: "RENT   1,325.00" → 1325
function extractRentFromText(text) {
  const m = String(text || '').trim().match(/^RENT\s+([\d,]+\.?\d*)/i)
  return m ? parseFloat(m[1].replace(/,/g, '')) : null
}

export function parseYardiDetailRR(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })

  // No explicit "as of" date in file — return blank so UI date-confirm step handles it
  const asOf = ''

  const raw = []        // collected unit objects before dedup
  let cur = null
  let inApplicant = false  // skip charge rows belonging to a future applicant sub-block

  for (let i = 1; i < rows.length; i++) {   // skip row 0 (header)
    const row = rows[i] || []
    const unitId = row[C_UNIT]
    const isUnitRow = unitId && typeof unitId === 'string' && /^\d+-\d+/.test(String(unitId))
    const statusCell = String(row[C_STATUS] || '').trim()
    const isApplicantBlock = !isUnitRow && /^applicant$/i.test(statusCell)

    if (isUnitRow) {
      inApplicant = false
      cur = {
        unit: String(unitId).trim(),
        utype: String(row[C_FP] || '').trim(),
        sqft: num(row[C_SQFT]),
        status: statusCell,
        name: String(row[C_NAME] || '').trim(),
        moveIn: toISODate(row[C_MOVEIN]),
        leaseEnd: toISODate(row[C_LEASEEND]),
        market: num(row[C_MARKET]),
        rent: extractRentFromText(row[C_TRANSCODE]),  // rent on first charge line
        totalBilling: num(row[C_TOTAL]),
        hasApplicant: false,
        rowIndex: i,
      }
      raw.push(cur)
    } else if (isApplicantBlock) {
      inApplicant = true
      if (cur) cur.hasApplicant = true
    } else if (cur && !inApplicant) {
      // Charge row for current unit — look for RENT text
      const rentAmt = extractRentFromText(row[C_TRANSCODE])
      if (rentAmt != null && cur.rent == null) cur.rent = rentAmt
    }
  }

  // Deduplicate: if a unit appears more than once (future lease rows), keep the first
  const byUnit = {}
  raw.forEach(u => { if (!byUnit[u.unit]) byUnit[u.unit] = u })

  let dupCount = 0, preleasedVacant = 0, reviewCount = 0
  const units = Object.values(byUnit).map(u => {
    const isVacant = /^vacant/i.test(u.status) || !u.name || u.name === ''
    const isPreLeased = isVacant && u.hasApplicant

    if (isPreLeased) preleasedVacant++

    let inplace = null, inplaceReview = false
    if (!isVacant) {
      if (u.rent != null && u.rent > 0) {
        inplace = u.rent
      } else if (u.totalBilling != null) {
        // Fallback: total billing is all charges; without fee breakdown use it as-is
        inplace = u.totalBilling
        inplaceReview = true
      } else {
        inplaceReview = true
      }
      // Sanity check vs market
      if (inplace != null && u.market != null &&
          (inplace < 0.4 * u.market || inplace > 1.4 * u.market)) {
        inplaceReview = true
      }
      if (inplaceReview) reviewCount++
    }

    return {
      unit: u.unit,
      utype: u.utype,
      sqft: u.sqft,
      tier: tierOf(u.sqft),
      vacant: isVacant,
      preLeased: isPreLeased,
      market: u.market,
      inplace,
      inplaceReview,
      fees: 0,
      leaseExp: u.leaseEnd,
      moveIn: u.moveIn,
      name: isVacant ? 'VACANT' : u.name,
      residentId: '',
    }
  })

  return {
    asOf,
    units,
    skipped: 0,
    dupCount,
    preleasedVacant,
    reviewCount,
  }
}

