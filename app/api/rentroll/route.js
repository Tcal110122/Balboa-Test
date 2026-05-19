import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')

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
