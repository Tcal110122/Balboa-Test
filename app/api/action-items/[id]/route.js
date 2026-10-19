// PATCH /api/action-items/:id  { status?, owner?, manager_response?, due_date?, ask? }
// Sponsor (Balboa) users only.

import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { adminClient } from '@/lib/packages/intake'

const STATUSES = ['open', 'sent', 'response_received', 'resolved']

export async function PATCH(request, { params }) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.isAllDeals) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const update = { updated_at: new Date().toISOString() }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    update.status = body.status
  }
  for (const k of ['owner', 'manager_response', 'ask']) if (body[k] !== undefined) update[k] = String(body[k]).trim() || null
  if (body.due_date !== undefined) update.due_date = body.due_date || null

  const db = adminClient()
  if (update.status === 'resolved') {
    const { data: latest } = await db.from('action_items').select('deal_id').eq('id', id).maybeSingle()
    if (latest) {
      const { data: pkg } = await db.from('packages').select('period').eq('deal_id', latest.deal_id).eq('status', 'parsed').order('period', { ascending: false }).limit(1).maybeSingle()
      update.resolved_period = pkg?.period || null
    }
  }
  const { data, error } = await db.from('action_items').update(update).eq('id', id).select('*').maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}
