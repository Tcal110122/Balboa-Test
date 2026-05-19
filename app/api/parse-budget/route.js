import { NextResponse } from 'next/server'
import { parseBudget } from '@/lib/budget-parser'
import supabase from '@/lib/supabase'

export async function POST(request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const dealId = formData.get('deal_id')

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!dealId) return NextResponse.json({ error: 'No deal_id provided' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const parsed = parseBudget(buffer)

    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { error } = await supabase
      .from('budget_snapshots')
      .insert({ deal_id: dealId, data: parsed })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, currentMonth: parsed.currentMonth, closedMonths: parsed.closedMonths })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
