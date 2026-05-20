import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')
  if (!dealId) return NextResponse.json({ error: 'No deal_id' }, { status: 400 })

  if (!canAccessDeal(auth, dealId)) {
    return NextResponse.json({ data: {} })
  }

  const { data, error } = await supabase
    .from('fp_maps')
    .select('data')
    .eq('deal_id', dealId)
    .single()

  if (error) return NextResponse.json({ data: {} })
  return NextResponse.json(data)
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { deal_id, data } = await request.json()
    if (!deal_id) return NextResponse.json({ error: 'No deal_id' }, { status: 400 })

    if (!canAccessDeal(auth, deal_id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { error } = await supabase
      .from('fp_maps')
      .upsert({ deal_id, data }, { onConflict: 'deal_id' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
