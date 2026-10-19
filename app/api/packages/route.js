// Lists received manager packages (newest first) for the deals the
// signed-in user can see. Optional ?deal_id= filter.

import { NextResponse } from 'next/server'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import { adminClient } from '@/lib/packages/intake'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const dealId = new URL(request.url).searchParams.get('deal_id')
  if (dealId && !canAccessDeal(auth, dealId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let q = adminClient()
    .from('packages')
    .select('id, deal_id, period, format, status, summary, error, created_at, deals(name)')
    .order('created_at', { ascending: false })
    .limit(100)
  if (dealId) q = q.eq('deal_id', dealId)
  else if (!auth.isAllDeals) {
    if (!auth.allowedDealIds?.length) return NextResponse.json([])
    q = q.in('deal_id', auth.allowedDealIds)
  }

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
