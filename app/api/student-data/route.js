import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')
  if (!dealId) return NextResponse.json({ error: 'No deal_id' }, { status: 400 })
  if (!canAccessDeal(auth, dealId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [plRes, rrRes] = await Promise.all([
    supabase
      .from('student_prelease_snapshots')
      .select('data, period, parsed_at')
      .eq('deal_id', dealId)
      .order('parsed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('student_rr_snapshots')
      .select('data, period, parsed_at')
      .eq('deal_id', dealId)
      .order('parsed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return NextResponse.json({
    prelease: plRes.data?.data ?? null,
    rr: rrRes.data?.data ?? null,
  })
}
