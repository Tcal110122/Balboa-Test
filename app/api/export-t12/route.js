import JSZip from 'jszip'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import supabase from '@/lib/supabase'

// Column letter helper (1=A, 2=B, …)
function col(n) {
  let s = ''
  while (n > 0) { s = String.fromCharCode(64 + (n % 26 || 26)) + s; n = Math.floor((n - 1) / 26) }
  return s
}

function cellRef(r, c) { return col(c) + r } // r=1-based row, c=1-based col

function numXml(r, c, v) {
  return `<c r="${cellRef(r, c)}" t="n"><v>${v ?? 0}</v></c>`
}
function strXml(r, c, si) {
  return `<c r="${cellRef(r, c)}" t="s"><v>${si}</v></c>`
}

function money(v) { return v == null ? 0 : Math.round(v) }

// OpenXML chart: line chart with 3 series
function buildChart(months, incomeVals, opexVals, noiVals, sheetName) {
  const dataRef = (colLetter, rows) =>
    `'${sheetName}'!$${colLetter}$2:$${colLetter}$${rows + 1}`
  const catRef = `'${sheetName}'!$A$2:$A$${months.length + 1}`

  const series = (idx, title, colLetter, color) => `
    <c:ser>
      <c:idx val="${idx}"/>
      <c:order val="${idx}"/>
      <c:tx><c:strRef><c:f>'${sheetName}'!$${colLetter}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${title}</c:v></c:pt></c:strCache></c:strRef></c:tx>
      <c:spPr><a:ln w="25400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></a:spPr>
      <c:marker><c:symbol val="none"/></c:marker>
      <c:cat><c:strRef><c:f>${catRef}</c:f><c:strCache><c:ptCount val="${months.length}"/>${months.map((m, i) => `<c:pt idx="${i}"><c:v>${m}</c:v></c:pt>`).join('')}</c:strCache></c:strRef></c:cat>
      <c:val><c:numRef><c:f>${dataRef(colLetter, months.length)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${months.length}"/>${(colLetter === 'B' ? incomeVals : colLetter === 'C' ? opexVals : noiVals).map((v, i) => `<c:pt idx="${i}"><c:v>${money(v)}</c:v></c:pt>`).join('')}</c:numCache></c:numRef></c:val>
      <c:smooth val="0"/>
    </c:ser>`

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:autoTitleDeleted val="0"/>
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>T-12 Financial Summary</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:lineChart>
        <c:barDir val="col"/>
        <c:grouping val="standard"/>
        <c:varyColors val="0"/>
        ${series(0, 'Total Income', 'B', '2563EB')}
        ${series(1, 'Operating Expenses', 'C', 'EF4444')}
        ${series(2, 'NOI', 'D', '16A34A')}
        <c:marker><c:symbol val="none"/></c:marker>
        <c:smooth val="0"/>
        <c:axId val="1"/><c:axId val="2"/>
      </c:lineChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:crossAx val="1"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/></c:legend>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`
}

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')
  if (!dealId) return new Response('deal_id required', { status: 400 })
  if (!canAccessDeal(auth, dealId)) return new Response('Forbidden', { status: 403 })

  const [dealRow, t12Row] = await Promise.all([
    supabase.from('deals').select('name').eq('id', dealId).maybeSingle(),
    supabase.from('t12_snapshots').select('period, data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  if (!t12Row.data) return new Response('No T-12 data found for this deal', { status: 404 })

  const dealName = dealRow.data?.name || 'Property'
  const t12 = t12Row.data.data || t12Row.data
  const months = (t12.months || []).map(m => m.label || String(m))
  const n = months.length

  const incomeVals = (t12.totalIncome?.vals || []).slice(0, n)
  const opexVals   = (t12.totalOpEx?.vals   || []).slice(0, n)
  const noiVals    = (t12.noi?.vals         || []).slice(0, n)

  // ── Build shared strings ──────────────────────────────────────────────────
  const strings = ['Month', 'Total Income', 'Operating Expenses', 'NOI', ...months]
  const si = str => strings.indexOf(str)
  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map(s => `<si><t xml:space="preserve">${s}</t></si>`).join('\n')}
</sst>`

  // ── Build worksheet ────────────────────────────────────────────────────────
  const headerRow = `<row r="1">${strXml(1,1,si('Month'))}${strXml(1,2,si('Total Income'))}${strXml(1,3,si('Operating Expenses'))}${strXml(1,4,si('NOI'))}</row>`
  const dataRows = months.map((m, i) => {
    const r = i + 2
    return `<row r="${r}">${strXml(r,1,si(m))}${numXml(r,2,money(incomeVals[i]))}${numXml(r,3,money(opexVals[i]))}${numXml(r,4,money(noiVals[i]))}</row>`
  }).join('\n')

  const lastDataRow = n + 1
  const sheetName = 'T-12 Data'

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetData>${headerRow}${dataRows}</sheetData>
  <drawing r:id="rId1"/>
</worksheet>`

  // ── Assemble zip ───────────────────────────────────────────────────────────
  const chartXml = buildChart(months, incomeVals, opexVals, noiVals, sheetName)

  const zip = new JSZip()

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml"                ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml"       ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml"           ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml"                  ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml"       ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
  <Override PartName="/xl/charts/chart1.xml"           ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
</Types>`)

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)

  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`)

  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"     Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"        Target="styles.xml"/>
</Relationships>`)

  zip.file('xl/worksheets/sheet1.xml', worksheetXml)

  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`)

  zip.file('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
           xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor moveWithCells="1" sizeWithCells="1">
    <xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>16</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>
      <xdr:cNvPr id="2" name="Chart 1"/>
      <xdr:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></xdr:cNvGraphicFramePr>
    </xdr:nvGraphicFramePr>
    <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
    <xdr:graphic xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
        <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/>
      </a:graphicData>
    </xdr:graphic>
    </xdr:graphicFrame><xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`)

  zip.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`)

  zip.file('xl/charts/chart1.xml', chartXml)

  zip.file('xl/sharedStrings.xml', sharedStringsXml)

  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`)

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const filename = `${dealName.replace(/[^a-z0-9]/gi, '_')}_T12.xlsx`

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    }
  })
}
