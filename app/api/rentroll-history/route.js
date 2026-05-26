import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')
  if (!dealId) return NextResponse.json({ error: 'deal_id required' }, { status: 400 })
  if (!canAccessDeal(auth, dealId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('rent_roll_snapshots')
    .select('as_of_date, units')
    .eq('deal_id', dealId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Sort by parsed date — dates stored as MM/DD/YYYY so string order is wrong
  const parseRrDate = s => {
    if (!s) return 0
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s).getTime()
    const [m, d, y] = s.split('/')
    return new Date(+y, +m - 1, +d).getTime()
  }
  ;(data || []).sort((a, b) => parseRrDate(b.as_of_date) - parseRrDate(a.as_of_date))

  return NextResponse.json(data || [])
}
