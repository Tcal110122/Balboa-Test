import { NextResponse } from 'next/server'
import { parseT12 } from '@/lib/t12-parser'
import supabase from '@/lib/supabase'

export async function POST(request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const dealId = formData.get('deal_id')

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!dealId) return NextResponse.json({ error: 'No deal_id provided' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const parsed = parseT12(buffer)

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
