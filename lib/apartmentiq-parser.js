import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }
function uid() { return Math.random().toString(36).slice(2, 9) }

const BED_DEFS = [
  { label: 'Studio / Small', re: /^studio$/i },
  { label: '1 Bed',          re: /^1 bed$/i },
  { label: '2 Bed',          re: /^2 bed$/i },
  { label: '3 Bed',          re: /^3 bed$/i },
]

export function parseApartmentIQ(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })

  const hasFPSheet = wb.SheetNames.some(n => /floor plan data/i.test(n))
  const msSN = wb.SheetNames.find(n => /^market survey$/i.test(n))
  if (!hasFPSheet || !msSN) {
    return { error: 'Not an ApartmentIQ report — expected "Market Survey" and "Floor Plan Data" sheets' }
  }

  const ms = wb.Sheets[msSN]
  const grid = XLSX.utils.sheet_to_json(ms, { header: 1, raw: true, defval: '' })

  // Row 2: col 1 = "Comp Average", col 2 = subject property, col 3+ = comps
  const propRow = grid[2] || []
  const subjectName = String(propRow[2] || '').trim()

  const compCols = []
  propRow.forEach((v, ci) => {
    if (ci <= 1) return
    const name = String(v || '').trim()
    if (!name || name === subjectName) return
    compCols.push({ ci, name })
  })

  if (!compCols.length) return { error: 'No comp properties found in the Market Survey sheet' }

  // Distance row
  const distRow = grid.find(r => /^distance$/i.test(String(r[0] || '').trim())) || []

  // Find section start rows for each bed type
  const sectionStarts = []
  grid.forEach((row, ri) => {
    const lbl = String(row[0] || '').trim()
    const match = BED_DEFS.find(bd => bd.re.test(lbl))
    if (match) sectionStarts.push({ ri, label: match.label })
  })

  // Within each section extract the SQFT and NER rows
  const bedRows = {}
  sectionStarts.forEach((sec, si) => {
    const end = sectionStarts[si + 1] ? sectionStarts[si + 1].ri : grid.length
    let sqftRow = null, nerRow = null
    for (let r = sec.ri + 1; r < end; r++) {
      const lbl = String(grid[r][0] || '').trim()
      if (/^sqft$/i.test(lbl)) sqftRow = grid[r]
      if (/^ner$/i.test(lbl) && !nerRow) nerRow = grid[r]
    }
    bedRows[sec.label] = { sqftRow, nerRow }
  })

  // Property Summary: asking rent (cols 7-10) and perf metrics per property
  const psSN = wb.SheetNames.find(n => /^property summary$/i.test(n))
  const psByName = {}
  if (psSN) {
    const psGrid = XLSX.utils.sheet_to_json(wb.Sheets[psSN], { header: 1, raw: true, defval: '' })
    psGrid.slice(3).forEach(row => {
      const name = String(row[0] || '').trim()
      if (!name) return
      psByName[name] = {
        'Studio / Small': num(row[7]),
        '1 Bed':          num(row[8]),
        '2 Bed':          num(row[9]),
        '3 Bed':          num(row[10]),
        yearBuilt:  num(row[2]),
        totalUnits: num(row[3]),
        leasedPct:  num(row[5]),
        exposure:   num(row[6]),
      }
    })
  }

  const comps = []
  compCols.forEach(cc => {
    const ps = psByName[cc.name] || {}
    const rows = []

    BED_DEFS.forEach(bd => {
      const br = bedRows[bd.label]
      if (!br) return
      const sf    = br.sqftRow ? num(br.sqftRow[cc.ci]) : null
      const ner   = br.nerRow  ? num(br.nerRow[cc.ci])  : null
      const gross = ps[bd.label] ?? null
      if (gross == null && ner == null) return
      const W = {
        '30': { gross, ner },
        '60': { gross, ner },
        '90': { gross, ner }
      }
      rows.push({
        bed: bd.label,
        sf: sf != null ? Math.round(sf) : '',
        source: 'hellodata',
        grossDirect: gross, nerDirect: ner,
        windows: W, asking: '', weeksFree: '', leaseMonths: 12
      })
    })

    if (!rows.length) return

    const distMi = num(distRow[cc.ci])
    comps.push({
      id: uid(), name: cc.name,
      distance: distMi != null ? distMi.toFixed(2) + ' mi' : '',
      units: ps.totalUnits != null ? String(Math.round(ps.totalUnits)) : '',
      source: 'hellodata', hdWindow: '30-day', rows,
      sfMatched: rows.some(r => r.sf !== ''),
      perf: {
        leasedPct: ps.leasedPct, exposure: ps.exposure,
        priceFreq: null, yearBuilt: ps.yearBuilt, quality: null,
        distanceMi: distMi, totalUnits: ps.totalUnits
      }
    })
  })

  return { comps, count: comps.length, sfEnriched: comps.filter(c => c.sfMatched).length }
}
