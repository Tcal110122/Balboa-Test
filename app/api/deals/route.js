import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth } from '@/lib/auth'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let query = supabase
    .from('deals')
    .select('id, name, market, address, unit_count, status, type')
    .order('name')

  if (!auth.isAllDeals) {
    if (!auth.allowedDealIds?.length) return NextResponse.json([])
    query = query.in('id', auth.allowedDealIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
