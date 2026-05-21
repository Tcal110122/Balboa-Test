import * as XLSX from 'xlsx'

function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n }
function uid() { return Math.random().toString(36).slice(2, 9) }

function parseUnitLevelData(wb) {
  const sheetName = wb.SheetNames.find(n => /unit-level data|unit level data/i.test(n))
  if (!sheetName) return null
  const ws = wb.Sheets[sheetName]
  let maxR = 0, maxC = 0
  Object.keys(ws).forEach(k => {
    if (k[0] === '!') return
    const cell = XLSX.utils.decode_cell(k)
    if (cell.r > maxR) maxR = cell.r
    if (cell.c > maxC) maxC = cell.c
  })
  if (maxR > 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } })
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })

  let hdrRow = -1
  for (let i = 0; i < Math.min(8, grid.length); i++) {
    const row = (grid[i] || []).map(v => String(v || '').toLowerCase())
    if (row.some(v => v.includes('property name')) && row.some(v => v.includes('sqft'))) { hdrRow = i; break }
  }
  if (hdrRow < 0) return null

  const hdr = (grid[hdrRow] || []).map(v => String(v || '').toLowerCase().trim())
  const col = (re) => hdr.findIndex(v => re.test(v))
  const cProp = col(/property name/), cBeds = col(/^beds$/), cSf = col(/^sqft$/)
  const cAsk = col(/asking rent/), cEff = col(/effective rent/)
  if (cProp < 0 || cSf < 0 || cBeds < 0) return null

  const byProp = {}
  for (let r = hdrRow + 1; r < grid.length; r++) {
    const row = grid[r] || []
    const prop = String(row[cProp] || '').trim()
    if (!prop || /^total$/i.test(prop)) continue
    const beds = num(row[cBeds])
    const sf = num(row[cSf])
    const ask = cAsk >= 0 ? num(row[cAsk]) : null
    const eff = cEff >= 0 ? num(row[cEff]) : null
    if (beds == null) continue
    const bed = beds === 0 ? 'Studio / Small' : beds === 1 ? '1 Bed' : beds === 2 ? '2 Bed' : '3 Bed'
    if (!byProp[prop]) byProp[prop] = {}
    if (!byProp[prop][bed]) byProp[prop][bed] = { sf: [], ask: [], eff: [] }
    const d = byProp[prop][bed]
    if (sf != null) d.sf.push(sf)
    if (ask != null) d.ask.push(ask)
    if (eff != null) d.eff.push(eff)
  }

  const out = {}
  Object.keys(byProp).forEach(prop => {
    out[prop] = {}
    Object.keys(byProp[prop]).forEach(bed => {
      const d = byProp[prop][bed]
      out[prop][bed] = {
        sf: d.sf.length ? d.sf.reduce((a, b) => a + b, 0) / d.sf.length : null,
        ask: d.ask.length ? d.ask.reduce((a, b) => a + b, 0) / d.ask.length : null,
        eff: d.eff.length ? d.eff.reduce((a, b) => a + b, 0) / d.eff.length : null
      }
    })
  })
  return out
}

function matchProperty(name, ulKeys) {
  if (!name) return null
  const norm = s => String(s).toLowerCase().replace(/apartments?|the |at |\s+/g, '')
  const target = norm(name)
  let best = null
  ulKeys.forEach(k => {
    const nk = norm(k)
    if (nk === target || nk.includes(target) || target.includes(nk)) best = k
  })
  return best
}

export function parseHelloData(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })

  let sheetName = wb.SheetNames.find(n => /rent comparison/i.test(n))
               || wb.SheetNames.find(n => /rent comps/i.test(n))
  if (!sheetName) return { error: 'No "Rent Comparison" sheet found — is this a HelloData Full export?' }

  const ws = wb.Sheets[sheetName]
  let mR = 0, mC = 0
  Object.keys(ws).forEach(k => {
    if (k[0] === '!') return
    const cell = XLSX.utils.decode_cell(k)
    if (cell.r > mR) mR = cell.r
    if (cell.c > mC) mC = cell.c
  })
  if (mR > 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: mR, c: mC } })

  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })

  let hdrRow = -1
  for (let i = 0; i < Math.min(12, grid.length); i++) {
    const row = grid[i] || []
    if (row.some(v => /property name/i.test(String(v))) ||
        row.some(v => /comps avg/i.test(String(v)))) {
      hdrRow = i; break
    }
  }
  if (hdrRow < 0) return { error: 'Could not locate the property header row in the HelloData sheet.' }

  const hdr = grid[hdrRow] || []
  // Subject column sits between "Property Name" and "Comps Avg" — include it, tagged
  const propNameCi = hdr.findIndex(v => /property name/i.test(String(v)))
  const compsAvgCi = hdr.findIndex(v => /comps avg/i.test(String(v)))
  const propCols = []
  hdr.forEach((v, ci) => {
    const s = String(v || '').trim()
    if (!s) return
    if (/property name|management|website/i.test(s)) return
    if (/comps avg|^\$△|^%△|^△/i.test(s)) return
    const isSubjectCol = propNameCi >= 0 && compsAvgCi >= 0 && ci > propNameCi && ci < compsAvgCi
    propCols.push({ ci, name: s, isSubject: isSubjectCol })
  })

  const labelCol = hdr.findIndex(v => /property name/i.test(String(v)))
  const lc = labelCol >= 0 ? labelCol : 1

  const metricRow = {}
  const metricDefs = [
    { key: 'distance', re: /^distance/i },
    { key: 'yearBuilt', re: /^year built/i },
    { key: 'totalUnits', re: /^#\s*units/i },
    { key: 'leasedPct', re: /^leased\s*%/i },
    { key: 'exposure', re: /^exposure/i },
    { key: 'priceFreq', re: /^price update frequency/i },
    { key: 'quality', re: /^quality/i }
  ]
  grid.forEach((row, ri) => {
    const lbl = String((row || [])[lc] || '').trim()
    metricDefs.forEach(md => { if (md.re.test(lbl)) metricRow[md.key] = ri })
  })

  const beds = [
    { bed: 'Studio / Small', gross: /^studio rents$/i, eff: /^studio effective rents$/i },
    { bed: '1 Bed', gross: /^1br rents$/i, eff: /^1br effective rents$/i },
    { bed: '2 Bed', gross: /^2br rents$/i, eff: /^2br effective rents$/i },
    { bed: '3 Bed', gross: /^3br rents$/i, eff: /^3br effective rents$/i }
  ]
  const sectionRow = {}
  grid.forEach((row, ri) => {
    const lbl = String((row || [])[lc] || '').trim()
    beds.forEach(b => {
      if (b.gross.test(lbl)) sectionRow[b.bed + '_gross'] = ri
      if (b.eff.test(lbl)) sectionRow[b.bed + '_eff'] = ri
    })
  })

  const unitLevel = parseUnitLevelData(wb)
  const ulKeys = unitLevel ? Object.keys(unitLevel) : []

  const comps = []
  propCols.forEach(pc => {
    const ulMatch = unitLevel ? matchProperty(pc.name, ulKeys) : null
    const ulData = ulMatch ? unitLevel[ulMatch] : null
    const rows = []
    beds.forEach(b => {
      const gr = sectionRow[b.bed + '_gross'], er = sectionRow[b.bed + '_eff']
      const W = {}
      ;['30', '60', '90'].forEach((w, i) => {
        const off = i + 1
        W[w] = {
          gross: (gr != null && grid[gr + off]) ? num(grid[gr + off][pc.ci]) : null,
          ner: (er != null && grid[er + off]) ? num(grid[er + off][pc.ci]) : null
        }
      })
      let sf = ''
      if (ulData && ulData[b.bed] && ulData[b.bed].sf != null) sf = Math.round(ulData[b.bed].sf)
      rows.push({
        bed: b.bed, sf, source: 'hellodata',
        grossDirect: W['30'].gross, nerDirect: W['30'].ner,
        windows: W, asking: '', weeksFree: '', leaseMonths: 12
      })
    })
    if (rows.some(r => r.nerDirect != null || r.grossDirect != null)) {
      const mv = (key) => { const ri = metricRow[key]; return ri != null ? num(grid[ri][pc.ci]) : null }
      const dist = mv('distance'), units = mv('totalUnits')
      comps.push({
        id: uid(), name: pc.name,
        distance: dist != null ? dist.toFixed(2) + ' mi' : '',
        units: units != null ? String(Math.round(units)) : '',
        source: 'hellodata', hdWindow: '30-day', rows,
        isSubject: !!pc.isSubject,
        sfMatched: !!ulData,
        perf: {
          leasedPct: mv('leasedPct'), exposure: mv('exposure'),
          priceFreq: mv('priceFreq'), yearBuilt: mv('yearBuilt'),
          quality: mv('quality'), distanceMi: dist, totalUnits: units
        }
      })
    }
  })

  return { comps, sheetName, count: comps.length, sfEnriched: unitLevel ? comps.filter(c => c.sfMatched).length : 0 }
}
