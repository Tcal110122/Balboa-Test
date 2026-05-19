import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }
function uid() { return Math.random().toString(36).slice(2, 9) }

// Column indices in the Property Summary sheet data row
// Property,CompScore,YearBuilt,TotalUnits,AdvertisedOcc,Leased%,Exposure%,
// [30-day asking] Studio=7,1BR=8,2BR=9,3BR=10, Avg=11, PSF=12
// [30-day eff]    Studio=13,1BR=14,2BR=15,3BR=16, Avg=17, PSF=18
// [30-day listings] 19-23
// [60-day asking] Studio=24,1BR=25,2BR=26,3BR=27
// [60-day eff]    Studio=30,1BR=31,2BR=32,3BR=33
// [60-day listings] 36-40
// [90-day asking] Studio=41,1BR=42,2BR=43,3BR=44
// [90-day eff]    Studio=47,1BR=48,2BR=49,3BR=50
const BEDS = [
  { label: 'Studio / Small', ask: [7, 24, 41], eff: [13, 30, 47] },
  { label: '1 Bed',          ask: [8, 25, 42], eff: [14, 31, 48] },
  { label: '2 Bed',          ask: [9, 26, 43], eff: [15, 32, 49] },
  { label: '3 Bed',          ask: [10,27, 44], eff: [16, 33, 50] }
]
const WINDOWS = ['30', '60', '90']

function getDistances(wb) {
  const ws = wb.Sheets['Market Survey']
  if (!ws) return {}
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  // Row 2 (index 2) has property names starting at col 1
  // Row 8 (index 8) has "Distance" label and values
  const propRow = grid[2] || []
  const distRow = grid.find(r => /^distance$/i.test(String((r || [])[0] || '').trim())) || []
  const out = {}
  propRow.forEach((v, ci) => {
    if (ci === 0) return
    const name = String(v || '').trim()
    if (name) out[name] = num(distRow[ci])
  })
  return out
}

export function parseRPMMarket(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })

  const sheetName = wb.SheetNames.find(n => /property summary/i.test(n))
  if (!sheetName) return { error: 'No "Property Summary" sheet found — is this an RPM Living market report?' }

  const ws = wb.Sheets[sheetName]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })

  // Data rows start at index 3 (0=blank/logo, 1=section header, 2=column labels, 3+=data)
  // Skip the "Average" row at the bottom
  const dataRows = grid.slice(3).filter(r => {
    const name = String((r || [])[0] || '').trim()
    return name && !/^average$/i.test(name)
  })

  const distances = getDistances(wb)

  // Determine the subject property (The Henry — first data row or the one with distance 0)
  const subjectName = String((dataRows[0] || [])[0] || '').trim()

  const comps = []
  dataRows.forEach(row => {
    const name = String(row[0] || '').trim()
    if (!name) return
    if (name === subjectName) return  // skip the subject property

    const rows = BEDS.map(b => {
      const W = {}
      WINDOWS.forEach((w, i) => {
        W[w] = { gross: num(row[b.ask[i]]), ner: num(row[b.eff[i]]) }
      })
      const hasData = WINDOWS.some(w => W[w].gross != null || W[w].ner != null)
      if (!hasData) return null
      return {
        bed: b.label, sf: '', source: 'hellodata',
        grossDirect: W['30'].gross, nerDirect: W['30'].ner,
        windows: W, asking: '', weeksFree: '', leaseMonths: 12
      }
    }).filter(Boolean)

    if (!rows.length) return

    const distMi = distances[name] ?? null
    const totalUnits = num(row[3])
    const leasedPct = num(row[5])
    const exposure = num(row[6])
    const yearBuilt = num(row[2])

    comps.push({
      id: uid(), name,
      distance: distMi != null ? distMi.toFixed(2) + ' mi' : '',
      units: totalUnits != null ? String(Math.round(totalUnits)) : '',
      source: 'hellodata', hdWindow: '30-day', rows,
      sfMatched: false,
      perf: { leasedPct, exposure, priceFreq: null, yearBuilt, quality: null, distanceMi: distMi, totalUnits }
    })
  })

  return { comps, count: comps.length, sfEnriched: 0 }
}
