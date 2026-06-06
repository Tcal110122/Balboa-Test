import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') || 'conventional' // 'conventional' | 'student'

  const admin = adminClient()

  // 1. Fetch all accessible deals of the requested type
  let dealQuery = admin
    .from('deals')
    .select('id, name, market, address, unit_count, type, property_manager')
    .order('name')

  if (!auth.isAllDeals) {
    if (!auth.allowedDealIds?.length) return NextResponse.json({ deals: [] })
    dealQuery = dealQuery.in('id', auth.allowedDealIds)
  }

  // Filter by type: student deals vs conventional/multifamily
  if (type === 'student') {
    dealQuery = dealQuery.eq('type', 'student')
  } else {
    dealQuery = dealQuery.neq('type', 'student')
  }

  const { data: deals, error: dealErr } = await dealQuery
  if (dealErr) return NextResponse.json({ error: dealErr.message }, { status: 500 })
  if (!deals?.length) return NextResponse.json({ deals: [] })

  const dealIds = deals.map(d => d.id)

  // 2. Fetch the latest T-12 snapshot for each deal
  // Get all recent snapshots, then dedupe to one per deal
  const { data: t12Rows, error: t12Err } = await admin
    .from('t12_snapshots')
    .select('deal_id, period, data, parsed_at')
    .in('deal_id', dealIds)
    .order('parsed_at', { ascending: false })

  if (t12Err) return NextResponse.json({ error: t12Err.message }, { status: 500 })

  // Dedupe — keep latest per deal_id
  const t12ByDeal = {}
  ;(t12Rows || []).forEach(row => {
    if (!t12ByDeal[row.deal_id]) t12ByDeal[row.deal_id] = row
  })

  // 3. Fetch latest budget snapshot for each deal
  const { data: budRows, error: budErr } = await admin
    .from('budget_snapshots')
    .select('deal_id, data, parsed_at')
    .in('deal_id', dealIds)
    .order('parsed_at', { ascending: false })

  const budByDeal = {}
  ;(budRows || []).forEach(row => {
    if (!budByDeal[row.deal_id]) budByDeal[row.deal_id] = row
  })

  // 4. Assemble response
  const result = deals.map(deal => {
    const t12 = t12ByDeal[deal.id]?.data || null
    const bud = budByDeal[deal.id]?.data || null
    const period = t12ByDeal[deal.id]?.period || null

    return {
      id: deal.id,
      name: deal.name,
      market: deal.market,
      unitCount: deal.unit_count || 1,
      type: deal.type,
      propertyManager: deal.property_manager,
      period,
      t12,
      budget: bud,
    }
  })

  return NextResponse.json({ deals: result })
}
