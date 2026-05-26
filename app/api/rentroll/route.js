import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

function parseRrDate(s) {
  if (!s) return 0
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s).getTime()
  const [m, d, y] = s.split('/')
  return new Date(+y, +m - 1, +d).getTime()
}

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

  if (dealId) query = query.eq('deal_id', dealId)

  const { data, error } = await query
  if (error || !data?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Dates stored as MM/DD/YYYY strings — sort by parsed value, not lexicographically
  data.sort((a, b) => parseRrDate(b.as_of_date) - parseRrDate(a.as_of_date))
  return NextResponse.json(data[0])
}
