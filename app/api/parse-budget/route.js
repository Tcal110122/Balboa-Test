import { NextResponse } from 'next/server'
import { parseBudget } from '@/lib/budget-parser'
import { parseStudentBudget } from '@/lib/student-budget-parser'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import * as XLSX from 'xlsx'

function detectBudgetFormat(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 8 })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    const topText = grid.slice(0, 8).map(r => String(r[0] || '')).join(' ')
    if (/realpage|budget year beginning/i.test(topText)) return 'student'
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
    const format = detectBudgetFormat(buffer)
    const parsed = format === 'student' ? parseStudentBudget(buffer) : parseBudget(buffer)

    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { error } = await supabase
      .from('budget_snapshots')
      .insert({ deal_id: dealId, data: parsed })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      success: true,
      format,
      currentMonth: parsed.currentMonth,
      closedMonths: parsed.closedMonths,
    })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
