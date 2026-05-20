import * as XLSX from 'xlsx'

export function parseStudentPrelease(buffer) {
  try {
    const wb = XLSX.read(buffer)
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

    const property = String(rows[1]?.[0] || '').trim()
    const period = String(rows[2]?.[0] || '').trim()

    // Row 7 (index 6) is the column header; data starts at index 7
    const floorplans = []
    let totals = null

    for (let i = 7; i < rows.length; i++) {
      const row = rows[i]
      const type = String(row[0]).trim()
      if (!type || type === 'Details') break
      if (type === 'Not Selected') continue
      if (type === 'Total/Average:') {
        totals = parseRow(row)
        break
      }
      floorplans.push({ type, ...parseRow(row) })
    }

    if (!floorplans.length) return { error: 'No floorplan data found in pre-lease report' }
    if (!totals) return { error: 'Total/Average row not found' }

    return { property, period, floorplans, totals }
  } catch (err) {
    return { error: err.message }
  }
}

function parseRow(row) {
  return {
    excludedUnits:         Number(row[1]) || 0,
    rentableUnits:         Number(row[2]) || 0,
    avgScheduledCharges:   Number(row[3]) || 0,
    occupiedCurrent:       Number(row[4]) || 0,
    newLease:              Number(row[5]) || 0,
    renewal:               Number(row[6]) || 0,
    total:                 Number(row[7]) || 0,
    percent:               Number(row[8]) || 0,
    projectedAvailability: Number(row[9]) || 0,
  }
}
