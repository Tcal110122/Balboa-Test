import { NextResponse } from 'next/server'
import { parseApartmentIQ } from '@/lib/apartmentiq-parser'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

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
    const parsed = parseApartmentIQ(buffer)

    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { error } = await supabase
      .from('comp_snapshots')
      .upsert({ deal_id: dealId, comps: parsed.comps, count: parsed.count, imported_at: new Date().toISOString() }, { onConflict: 'deal_id' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, count: parsed.count, sfEnriched: parsed.sfEnriched })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
