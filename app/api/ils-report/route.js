import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth } from '@/lib/auth'
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, HeadingLevel,
  PageBreak, Header, Footer, PageNumber, VerticalAlign,
} from 'docx'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const BRAND_GREEN  = '1A6B5A'
const BRAND_DARK   = '1E293B'
const ISSUE_RED    = 'DC2626'
const WARN_AMBER   = 'B45309'
const LIGHT_GREEN  = 'F0FDF4'
const LIGHT_RED    = 'FEF2F2'
const LIGHT_GRAY   = 'F8FAFC'
const BORDER_GRAY  = 'E2E8F0'

const PLATFORMS = ['website', 'apartments_com', 'zillow', 'apartment_list']
const PLATFORM_LABELS = {
  website: 'Property Website',
  apartments_com: 'Apartments.com',
  zillow: 'Zillow',
  apartment_list: 'Apartment List',
}

async function getClaudeAnalysis(propertyName, platforms) {
  const formatPlatform = (key) => {
    const p = platforms[key]
    if (!p) return 'Not configured'
    return [
      p.rent_min ? `Starting Rent: $${p.rent_min.toLocaleString()}` : 'Starting Rent: Not listed',
      p.rent_max ? `Max Rent: $${p.rent_max.toLocaleString()}` : null,
      p.specials ? `Special: ${p.specials}` : 'Special: None',
      p.available_units != null ? `Available Units: ${p.available_units}` : null,
      p.phone ? `Phone: ${p.phone}` : null,
      p.notes ? `Notes: ${p.notes}` : null,
    ].filter(Boolean).join('\n')
  }

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are a real estate asset manager auditing ILS listing accuracy for "${propertyName}". The property website is the source of truth.

${PLATFORMS.map(p => `--- ${PLATFORM_LABELS[p]} ---\n${formatPlatform(p)}`).join('\n\n')}

Analyze the data and respond with ONLY this JSON (no markdown, no explanation):
{
  "executive_summary": "<2-3 sentence summary of overall audit findings>",
  "issues": ["<specific issue 1>", "<specific issue 2>"],
  "recommendations": ["<action item 1 for PM>", "<action item 2 for PM>"],
  "overall_status": "ok" | "warning" | "critical"
}

Flag as issues: rent differs by >$50 or >5% from website, website has a special but ILS does not, ILS rent is lower than website, missing phone numbers. If no issues found, say so clearly.`,
    }],
  })

  try {
    const json = msg.content[0].text.match(/\{[\s\S]+\}/)?.[0]
    return JSON.parse(json)
  } catch {
    return {
      executive_summary: 'Analysis could not be generated.',
      issues: [],
      recommendations: [],
      overall_status: 'ok',
    }
  }
}

function cell(text, opts = {}) {
  const { bold = false, color = BRAND_DARK, bg = null, align = AlignmentType.LEFT, shade = false } = opts
  const shading = bg ? { fill: bg, type: ShadingType.CLEAR } : undefined
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY },
      left:   { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY },
      right:  { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY },
    },
    children: [new Paragraph({
      alignment: align,
      children: [new TextRun({ text: text || '—', bold, color, font: 'Arial', size: 20 })],
    })],
  })
}

function headerCell(text) {
  return cell(text, { bold: true, color: 'FFFFFF', bg: BRAND_GREEN })
}

function buildComparisonTable(platforms) {
  const websiteData = platforms.website || {}

  function flagColor(key, platform) {
    if (key === 'platform') return null
    const w = platforms.website || {}
    const p = platforms[platform] || {}
    if (key === 'rent_min' && w.rent_min && p.rent_min) {
      const diff = Math.abs(p.rent_min - w.rent_min)
      const pct = diff / w.rent_min
      if (diff > 75 || pct > 0.05) return p.rent_min < w.rent_min ? LIGHT_RED : LIGHT_RED
    }
    if (key === 'specials' && w.specials && !p.specials) return LIGHT_RED
    return null
  }

  const rows = [
    { label: 'Starting Rent', key: 'rent_min', fmt: v => v ? `$${Number(v).toLocaleString()}` : null },
    { label: 'Max Rent',      key: 'rent_max', fmt: v => v ? `$${Number(v).toLocaleString()}` : null },
    { label: 'Specials / Concessions', key: 'specials', fmt: v => v || null },
    { label: 'Available Units', key: 'available_units', fmt: v => v != null ? String(v) : null },
    { label: 'Phone',         key: 'phone',   fmt: v => v || null },
    { label: 'Notes',         key: 'notes',   fmt: v => v || null },
  ]

  const COL_WIDTHS = [1680, 1920, 1920, 1920, 1920] // sum = 9360

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: COL_WIDTHS,
    rows: [
      // Header
      new TableRow({
        tableHeader: true,
        children: [
          new TableCell({
            width: { size: COL_WIDTHS[0], type: WidthType.DXA },
            shading: { fill: BRAND_GREEN, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            borders: { top: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN }, bottom: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN }, left: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN }, right: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN } },
            children: [new Paragraph({ children: [new TextRun({ text: 'Data Point', bold: true, color: 'FFFFFF', font: 'Arial', size: 20 })] })],
          }),
          ...PLATFORMS.map((p, i) => new TableCell({
            width: { size: COL_WIDTHS[i + 1], type: WidthType.DXA },
            shading: { fill: BRAND_GREEN, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 120, right: 120 },
            borders: { top: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN }, bottom: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN }, left: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN }, right: { style: BorderStyle.SINGLE, size: 1, color: BRAND_GREEN } },
            children: [new Paragraph({ children: [new TextRun({ text: PLATFORM_LABELS[p] + (p === 'website' ? ' ✓' : ''), bold: true, color: 'FFFFFF', font: 'Arial', size: 20 })] })],
          })),
        ],
      }),
      // Data rows
      ...rows.map((row, ri) => new TableRow({
        children: [
          new TableCell({
            width: { size: COL_WIDTHS[0], type: WidthType.DXA },
            shading: { fill: LIGHT_GRAY, type: ShadingType.CLEAR },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            borders: { top: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY }, left: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY }, right: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY } },
            children: [new Paragraph({ children: [new TextRun({ text: row.label, bold: true, font: 'Arial', size: 20, color: BRAND_DARK })] })],
          }),
          ...PLATFORMS.map((p, i) => {
            const val = row.fmt((platforms[p] || {})[row.key])
            const bg = p !== 'website' ? (flagColor(row.key, p) || (ri % 2 === 0 ? 'FFFFFF' : 'FAFAFA')) : (ri % 2 === 0 ? 'FFFFFF' : 'FAFAFA')
            return new TableCell({
              width: { size: COL_WIDTHS[i + 1], type: WidthType.DXA },
              shading: { fill: bg.replace('#', ''), type: ShadingType.CLEAR },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              borders: { top: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY }, left: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY }, right: { style: BorderStyle.SINGLE, size: 1, color: BORDER_GRAY } },
              children: [new Paragraph({
                children: [new TextRun({
                  text: val || '—',
                  font: 'Arial',
                  size: 20,
                  color: val ? BRAND_DARK : '9CA3AF',
                  italics: !val,
                })],
              })],
            })
          }),
        ],
      })),
    ],
  })
}

function para(text, opts = {}) {
  const { bold = false, size = 22, color = BRAND_DARK, spacing = 200, heading } = opts
  return new Paragraph({
    heading,
    spacing: { after: spacing },
    children: [new TextRun({ text, bold, size, color, font: 'Arial' })],
  })
}

function bullet(text, color = BRAND_DARK) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 120 },
    children: [new TextRun({ text, font: 'Arial', size: 20, color })],
  })
}

async function buildDoc(propertyName, propertyAddress, auditDate, platforms, analysis) {
  const statusColor = analysis.overall_status === 'ok' ? '15803D'
    : analysis.overall_status === 'critical' ? ISSUE_RED
    : WARN_AMBER
  const statusText = analysis.overall_status === 'ok' ? 'No Issues Found'
    : analysis.overall_status === 'critical' ? 'Critical Issues Found'
    : 'Issues Found'

  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Arial', size: 22 } } },
      paragraphStyles: [
        {
          id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 36, bold: true, color: BRAND_DARK, font: 'Arial' },
          paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 },
        },
        {
          id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: BRAND_GREEN, font: 'Arial' },
          paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 1 },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND_GREEN, space: 4 } },
            spacing: { after: 0 },
            children: [new TextRun({ text: 'ILS AUDIT REPORT  ·  BALBOA REAL ESTATE PARTNERS', font: 'Arial', size: 16, color: '9CA3AF' })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_GRAY, space: 4 } },
            children: [
              new TextRun({ text: 'Page ', font: 'Arial', size: 16, color: '9CA3AF' }),
              new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: '9CA3AF' }),
              new TextRun({ text: ' of ', font: 'Arial', size: 16, color: '9CA3AF' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: 'Arial', size: 16, color: '9CA3AF' }),
            ],
          })],
        }),
      },
      children: [
        // ── Cover / Title ──
        new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: '', size: 22 })] }),
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: 'ILS AUDIT REPORT', bold: true, size: 56, color: BRAND_GREEN, font: 'Arial' })],
        }),
        new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: propertyName, bold: true, size: 40, color: BRAND_DARK, font: 'Arial' })],
        }),
        ...(propertyAddress ? [new Paragraph({
          spacing: { after: 80 },
          children: [new TextRun({ text: propertyAddress, size: 22, color: '6B7280', font: 'Arial' })],
        })] : []),
        new Paragraph({
          spacing: { after: 400 },
          children: [new TextRun({ text: `Audit Date: ${auditDate}    ·    Prepared by: Balboa Real Estate Partners`, size: 20, color: '9CA3AF', font: 'Arial' })],
        }),

        // Status badge line
        new Paragraph({
          spacing: { after: 480 },
          children: [
            new TextRun({ text: 'Overall Status:  ', size: 22, color: BRAND_DARK, font: 'Arial' }),
            new TextRun({ text: statusText, bold: true, size: 24, color: statusColor, font: 'Arial' }),
          ],
        }),

        // ── Executive Summary ──
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 0, after: 200 }, children: [new TextRun({ text: 'Executive Summary', bold: true, size: 36, color: BRAND_DARK, font: 'Arial' })] }),
        new Paragraph({
          spacing: { after: 400 },
          children: [new TextRun({ text: analysis.executive_summary, size: 22, color: BRAND_DARK, font: 'Arial' })],
        }),

        // ── Comparison Table ──
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 0, after: 200 }, children: [new TextRun({ text: 'Platform Comparison', bold: true, size: 36, color: BRAND_DARK, font: 'Arial' })] }),
        new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: 'Property Website is the source of truth. Red cells indicate discrepancies.', size: 18, color: '6B7280', font: 'Arial', italics: true })] }),
        buildComparisonTable(platforms),

        // ── Issues & Recommendations ──
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 480, after: 200 }, children: [new TextRun({ text: 'Issues & Recommendations', bold: true, size: 36, color: BRAND_DARK, font: 'Arial' })] }),

        // Issues
        new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Issues Identified', bold: true, size: 24, color: ISSUE_RED, font: 'Arial' })] }),
        ...(analysis.issues?.length
          ? analysis.issues.map(i => bullet(i, BRAND_DARK))
          : [new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'No issues identified. All platforms are consistent with the property website.', size: 22, color: '15803D', font: 'Arial' })] })]
        ),

        // Recommendations
        new Paragraph({ spacing: { before: 280, after: 120 }, children: [new TextRun({ text: 'Recommended Actions', bold: true, size: 24, color: BRAND_GREEN, font: 'Arial' })] }),
        ...(analysis.recommendations?.length
          ? analysis.recommendations.map(r => bullet(r))
          : [new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'No action required at this time.', size: 22, color: '9CA3AF', font: 'Arial' })] })]
        ),

        // ── URLs audited ──
        new Paragraph({ spacing: { before: 400, after: 160 }, children: [new TextRun({ text: 'URLs Audited', bold: true, size: 22, color: '6B7280', font: 'Arial' })] }),
        ...PLATFORMS.map(p => {
          const url = (platforms[p] || {}).url
          return new Paragraph({
            spacing: { after: 80 },
            children: [
              new TextRun({ text: `${PLATFORM_LABELS[p]}: `, bold: true, size: 18, color: '9CA3AF', font: 'Arial' }),
              new TextRun({ text: url || 'Not configured', size: 18, color: '9CA3AF', font: 'Arial' }),
            ],
          })
        }),
      ],
    }],
  })

  return Packer.toBuffer(doc)
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { property_name, property_address, audit_date, platforms } = await request.json()
    if (!property_name) return NextResponse.json({ error: 'property_name required' }, { status: 400 })

    const [analysis, ] = await Promise.all([
      getClaudeAnalysis(property_name, platforms),
    ])

    const buffer = await buildDoc(property_name, property_address, audit_date, platforms, analysis)

    const slug = property_name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="ILS-Audit-${slug}-${audit_date}.docx"`,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
