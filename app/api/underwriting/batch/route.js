import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isStaff = auth.isAllDeals ||
    (auth.user.email || '').toLowerCase().endsWith('@thebalboagroup.com')
  if (!isStaff) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let deals
  try { deals = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!Array.isArray(deals) || !deals.length) return NextResponse.json({ error: 'No deals provided' }, { status: 400 })

  const admin = adminClient()
  const results = { inserted: 0, errors: [] }

  for (const d of deals) {
    const { error } = await admin.from('underwriting_deals').insert({
      name:         d.name,
      market:       d.market || '',
      type:         d.type || 'conventional',
      unit_count:   d.unit_count || null,
      data_year:    d.data_year || null,
      t12_period:   d.t12_period || null,
      t12_data:     d.t12_data || null,
      parse_status: d.parse_status || 'ok',
      parse_notes:  d.parse_notes || [],
      source:       d.source || 'box-import',
      created_by:   auth.user.id,
    })
    if (error) results.errors.push({ name: d.name, error: error.message })
    else results.inserted++
  }

  return NextResponse.json(results)
}
