import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')

  let query = supabase
    .from('budget_snapshots')
    .select('deal_id, data')
    .order('parsed_at', { ascending: false })
    .limit(1)

  if (dealId) query = query.eq('deal_id', dealId)

  const { data, error } = await query.single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json(data)
}
