import { NextResponse } from 'next/server'
import { parseT12 } from '@/lib/t12-parser'
import { parseComparisonT12 } from '@/lib/comparison-t12-parser'
import * as XLSX from 'xlsx'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

function detectT12Format(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 3, cellDates: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
    const row0 = grid[0] || []
    const row1 = grid[1] || []
    // Comparison format: row 0 has Date objects, row 1 has Actual/Budget strings
    const isDateLike = v => v instanceof Date || (typeof v === 'number' && v > 40000 && v < 80000)
    const hasDates = row0.some(isDateLike)
    const hasActualBudget = row1.some(v => typeof v === 'string' && /^(actual|budget)$/i.test(String(v).trim()))
    if (hasDates && hasActualBudget) return 'comparison'
  } catch (_) {}
  return 'standard'
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const dealId = formData.get('deal_id')

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!dealId) return NextResponse.json({ error: 'No deal_id provided' }, { status: 400 })
    if (!canAccessDeal(auth, dealId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const format = detectT12Format(buffer)
    const parsed = format === 'comparison' ? parseComparisonT12(buffer) : parseT12(buffer)

    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { error } = await supabase
      .from('t12_snapshots')
      .upsert(
        { deal_id: dealId, period: parsed.period, data: parsed, parsed_at: new Date().toISOString() },
        { onConflict: 'deal_id,period' }
      )

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, period: parsed.period, months: parsed.months.length })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
