import * as XLSX from 'xlsx'

export function parseStudentRR(buffer) {
  try {
    const wb = XLSX.read(buffer)
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

    const property = String(rows[1]?.[0] || '').trim()
    const period = String(rows[2]?.[0] || '').trim()

    // Find "Average Charges by Unit Type Summary" section
    let summaryStart = -1
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).includes('Average Charges by Unit Type Summary')) {
        summaryStart = i + 2 // skip header row
        break
      }
    }

    if (summaryStart === -1) return { error: 'Average Charges by Unit Type Summary not found' }

    const floorplans = []
    let totals = null

    for (let i = summaryStart; i < rows.length; i++) {
      const row = rows[i]
      const type = String(row[0]).trim()
      if (!type) break
      if (type === 'Average:') {
        totals = {
          rentableUnits:    Number(row[1]) || 0,
          occupiedUnits:    Number(row[2]) || 0,
          marketRent:       Number(row[3]) || 0,
          scheduledCharges: Number(row[4]) || 0,
        }
        break
      }
      floorplans.push({
        type,
        rentableUnits:    Number(row[1]) || 0,
        occupiedUnits:    Number(row[2]) || 0,
        marketRent:       Number(row[3]) || 0,
        scheduledCharges: Number(row[4]) || 0,
      })
    }

    if (!floorplans.length) return { error: 'No floorplan data found in rent roll summary' }
    if (!totals) return { error: 'Average total row not found' }

    return { property, period, floorplans, totals }
  } catch (err) {
    return { error: err.message }
  }
}
