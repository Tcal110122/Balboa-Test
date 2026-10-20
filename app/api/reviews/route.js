// GET  /api/reviews?deal_id=...[&period=YYYY-MM-01]
//   -> { packages, periods, review, action_items }
// POST /api/reviews  { deal_id, period? }   (sponsor only)
//   -> drafts (or redrafts) the review for that month with Claude

import { NextResponse } from 'next/server'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import { adminClient } from '@/lib/packages/intake'
import { generateReview } from '@/lib/reviews/generate'

export const maxDuration = 300

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const params = new URL(request.url).searchParams
  const dealId = params.get('deal_id')
  if (!dealId) return NextResponse.json({ error: 'deal_id required' }, { status: 400 })
  if (!canAccessDeal(auth, dealId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = adminClient()
  const [{ data: packages }, { data: reviews }, { data: items }] = await Promise.all([
    db.from('packages').select('id, period, format, status, summary, error, created_at').eq('deal_id', dealId).order('created_at', { ascending: false }).limit(24),
    db.from('am_reviews').select('id, period, status, created_at, approved_at, sent_at').eq('deal_id', dealId).order('period', { ascending: false }).order('created_at', { ascending: false }).limit(36),
    db.from('action_items').select('*').eq('deal_id', dealId).order('opened_period', { ascending: false }).order('created_at'),
  ])

  // Default to the newest month that has either a review or a parsed package.
  const newestPackage = (packages || []).filter(p => p.status === 'parsed' && p.period).map(p => p.period).sort().pop() || null
  const newestReview = reviews?.[0]?.period || null
  const period = params.get('period') || [newestPackage, newestReview].filter(Boolean).sort().pop() || null
  let review = null
  if (period) {
    // Prefer the sent/approved version of a month over a newer draft.
    const forMonth = (reviews || []).filter(r => r.period === period)
    const chosen = forMonth.find(r => r.status !== 'draft') || forMonth[0]
    if (chosen) {
      const { data } = await db.from('am_reviews').select('*').eq('id', chosen.id).single()
      review = data
    }
  }

  return NextResponse.json({
    can_edit: auth.isAllDeals,
    packages: packages || [],
    // Months with a review or a parsed package, newest first.
    periods: [...new Set([...(reviews || []).map(r => r.period), ...(packages || []).filter(p => p.status === 'parsed' && p.period).map(p => p.period)])].sort().reverse(),
    period,
    review,
    action_items: items || [],
  })
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.isAllDeals) return NextResponse.json({ error: 'Only Balboa staff can generate reviews' }, { status: 403 })
  const { deal_id: dealId, period } = await request.json().catch(() => ({}))
  if (!dealId) return NextResponse.json({ error: 'deal_id required' }, { status: 400 })

  try {
    const review = await generateReview(adminClient(), dealId, period || null)
    return NextResponse.json({ ok: true, review })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 })
  }
}
