import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')

  if (dealId && !canAccessDeal(auth, dealId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let query = supabase
    .from('rent_roll_snapshots')
    .select('deal_id, as_of_date, units')
    .order('as_of_date', { ascending: false })
    .limit(1)

  if (dealId) query = query.eq('deal_id', dealId)

  const { data, error } = await query.single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json(data)
}
