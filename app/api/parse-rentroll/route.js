import { NextResponse } from 'next/server'
import { parseRentRoll } from '@/lib/rentroll-parser'
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
    const parsed = parseRentRoll(buffer)

    if (!parsed.units.length) {
      return NextResponse.json(
        { error: 'No units found. Make sure this is a Yardi "Rent Roll with Lease Charges" export.' },
        { status: 400 }
      )
    }

    const { error } = await supabase
      .from('rent_roll_snapshots')
      .upsert(
        { deal_id: dealId, as_of_date: parsed.asOf, units: parsed.units },
        { onConflict: 'deal_id,as_of_date' }
      )

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      success: true,
      asOf: parsed.asOf,
      unitCount: parsed.units.length,
      occupied: parsed.units.filter(u => !u.vacant).length,
      vacant: parsed.units.filter(u => u.vacant).length,
      dupCount: parsed.dupCount,
      reviewCount: parsed.reviewCount
    })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
