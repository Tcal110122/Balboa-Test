/**
 * Parser for RealPage BI "Rent Roll" export format.
 *
 * Structure:
 *   Sheets: "Floorplan Summary", "Occupancy & Rent Summary", "Rent Roll Detail", "Unit Billing Detail"
 *   Target: "Rent Roll Detail" sheet
 *
 *   Rows 0-8: metadata/title (including "As Of Date: ...")
 *   Row 9:    column headers
 *   Row 10+:  data (one row per unit/lease; same unit may appear multiple times for renewals)
 *
 * Key columns (0-indexed, derived from header row):
 *   1  Unit #     2  Floor Plan    4  SQFT          5  Unit/Lease Status
 *   6  Resident   8  Move In       15 Lease End     16 Market Rent
 *   17 Lease Rent 21 Amenities     23 Total Billing
 */

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
    const y = v.getUTCFullYear(), mo = v.getUTCMonth() + 1, d = v.getUTCDate()
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  }
  if (typeof v === 'number' && v > 0) {
    const dt = new Date(Math.round((v - 25569) * 86400 * 1000))
    if (!isNaN(dt)) return dt.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0')
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) { let yr = m[3]; if (yr.length === 2) yr = '20' + yr; return yr + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') }
  return ''
}

const VACANT_RE = /^(vacant|vacant-leased|model|storage|admin|down|co|const|emp|employee)/i
const SKIP_RE   = /^(pending renewal|applicant|pending)$/i

export function parseRealPageBIRR(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })

  const sheetName = wb.SheetNames.find(n => /rent roll detail/i.test(n)) || wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })

  // Parse as-of date from header area
  let asOf = ''
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    for (const cell of rows[i] || []) {
      const m = String(cell || '').match(/as\s+of\s+date:\s*(.+)/i)
      if (m) {
        const d = new Date(m[1].trim())
        if (!isNaN(d)) asOf = d.toISOString().slice(0, 10)
        break
      }
    }
    if (asOf) break
  }

  // Find header row (contains "Unit #")
  let headerRow = -1
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    if ((rows[i] || []).some(c => /^unit\s*#$/i.test(String(c || '')))) {
      headerRow = i
      break
    }
  }
  if (headerRow === -1) return { error: 'Could not find header row in Rent Roll Detail sheet' }

  const hdr = rows[headerRow]
  const col = (re) => hdr.findIndex(c => re.test(String(c || '')))

  const C_UNIT     = col(/^unit\s*#$/i)
  const C_FP       = col(/^floor\s*plan$/i)
  const C_SQFT     = col(/^sqft$/i)
  const C_STATUS   = col(/unit.*lease.*status/i)
  const C_NAME     = col(/resident\s*name/i)
  const C_MOVEIN   = col(/^move\s*in\s*$/i)
  const C_LEASEEND = col(/^lease\s*end$/i)
  const C_MARKET   = col(/^market\s*rent$/i)
  const C_LEASRENT = col(/^lease\s*rent$/i)
  const C_AMENITY  = col(/^amenities$/i)
  const C_TOTAL    = col(/^total\s*billing$/i)

  // Collect raw rows, dedup by unit keeping first row; note if more rows exist
  const byUnit = {}
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i] || []
    const unitId = String(row[C_UNIT] || '').trim()
    if (!unitId) continue

    const status = String(row[C_STATUS] || '').trim()

    if (!byUnit[unitId]) {
      byUnit[unitId] = {
        unit:         unitId,
        utype:        String(row[C_FP] || '').trim(),
        sqft:         num(row[C_SQFT]),
        status,
        name:         String(row[C_NAME] || '').trim(),
        moveIn:       toISODate(row[C_MOVEIN]),
        leaseEnd:     toISODate(row[C_LEASEEND]),
        market:       num(row[C_MARKET]),
        leaseRent:    num(row[C_LEASRENT]),
        amenities:    num(row[C_AMENITY]) || 0,
        totalBilling: num(row[C_TOTAL]),
        hasExtra:     false,
        extraVacantLeased: false,
      }
    } else {
      byUnit[unitId].hasExtra = true
      if (/^vacant-leased$/i.test(status)) byUnit[unitId].extraVacantLeased = true
    }
  }

  let dupCount = 0, preleasedVacant = 0, reviewCount = 0
  const units = Object.values(byUnit)
    .filter(u => !SKIP_RE.test(u.status))
    .map(u => {
      if (u.hasExtra) dupCount++

      const isVacant = VACANT_RE.test(u.status) || !u.name
      // Pre-leased: physically vacant but has a signed future lease
      const isPreLeased = isVacant && (u.hasExtra || /^vacant-leased$/i.test(u.status))
      if (isPreLeased) preleasedVacant++

      let inplace = null, inplaceReview = false
      if (!isVacant) {
        if (u.leaseRent != null && u.leaseRent > 0) {
          inplace = u.leaseRent
        } else if (u.totalBilling != null && u.totalBilling > 0) {
          inplace = u.totalBilling - u.amenities
          inplaceReview = true
        } else {
          inplaceReview = true
        }
        if (inplace != null && u.market != null && u.market > 0 &&
            (inplace < 0.4 * u.market || inplace > 1.5 * u.market)) {
          inplaceReview = true
        }
        if (inplaceReview) reviewCount++
      }

      return {
        unit:          u.unit,
        utype:         u.utype,
        sqft:          u.sqft,
        tier:          tierOf(u.sqft),
        vacant:        isVacant,
        preLeased:     isPreLeased,
        market:        u.market,
        inplace,
        inplaceReview,
        fees:          u.amenities,
        leaseExp:      u.leaseEnd,
        moveIn:        u.moveIn,
        name:          isVacant ? 'VACANT' : u.name,
        residentId:    '',
      }
    })

  return { asOf, units, skipped: 0, dupCount, preleasedVacant, reviewCount }
}
