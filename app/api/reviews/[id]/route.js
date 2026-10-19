// POST /api/reviews/:id  { action: 'approve', items: [{ index, include, owner, due_date, ask }] }
//   Approves the draft and turns its action items into tracked items.
// POST /api/reviews/:id  { action: 'send', to: [...], cc: [...] }
//   Emails the open asks to the manager from reports@ and marks them sent.
// Sponsor (Balboa) users only.

import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { adminClient } from '@/lib/packages/intake'
import * as mail from '@/lib/packages/graph'

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const monthLabel = p => new Date(`${p}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

async function approve(db, review, auth, body) {
  if (review.status !== 'draft') return { error: 'This review is already approved', status: 409 }
  const proposed = review.content?.action_items || []
  const choices = new Map((body.items || []).map(i => [i.index, i]))
  const rows = proposed.map((item, index) => ({ item, choice: choices.get(index) || {} }))
    .filter(({ choice }) => choice.include !== false)
    .map(({ item, choice }) => ({
      deal_id: review.deal_id, review_id: review.id, opened_period: review.period,
      title: item.title, ask: (choice.ask || item.ask || '').trim(), at_stake: item.at_stake || null,
      owner: choice.owner || null, due_date: choice.due_date || null, status: 'open',
    }))
  if (rows.length) {
    const { error } = await db.from('action_items').insert(rows)
    if (error) return { error: error.message, status: 500 }
  }
  const { error } = await db.from('am_reviews').update({ status: 'approved', approved_by: auth.user.id, approved_at: new Date().toISOString() }).eq('id', review.id)
  if (error) return { error: error.message, status: 500 }
  return { ok: true, created: rows.length }
}

async function send(db, review, body) {
  if (review.status === 'draft') return { error: 'Approve the review before sending it', status: 409 }
  if (!mail.isConfigured()) return { error: 'Mailbox not configured', status: 500 }
  const to = (body.to || []).map(s => String(s).trim()).filter(Boolean)
  const cc = (body.cc || []).map(s => String(s).trim()).filter(Boolean)
  if (!to.length || ![...to, ...cc].every(isEmail)) return { error: 'Enter valid recipient email addresses', status: 400 }

  const { data: deal } = await db.from('deals').select('name').eq('id', review.deal_id).single()
  const { data: items } = await db.from('action_items').select('id, title, ask, due_date, status, opened_period')
    .eq('deal_id', review.deal_id).in('status', ['open', 'sent']).order('opened_period').order('created_at')
  if (!items?.length) return { error: 'No open action items to send', status: 400 }

  const newItems = items.filter(i => i.opened_period === review.period)
  const carried = items.filter(i => i.opened_period !== review.period)
  const li = i => `<li style="margin:0 0 12px"><b>${esc(i.title)}</b>${i.due_date ? ` <span style="color:#6b7280">(due ${esc(i.due_date)})</span>` : ''}<br>${esc(i.ask)}</li>`
  const month = monthLabel(review.period)
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:640px">
<p>Hello,</p>
<p>Thank you for the ${esc(month)} package for ${esc(deal?.name)}. Following our review, please respond to the items below. Reply to this email with your answers and supporting documents.</p>
${newItems.length ? `<p style="margin:18px 0 8px"><b>New this month</b></p><ol>${newItems.map(li).join('')}</ol>` : ''}
${carried.length ? `<p style="margin:18px 0 8px"><b>Still open from prior months</b></p><ol>${carried.map(li).join('')}</ol>` : ''}
<p>Thank you,<br>Balboa Real Estate Partners</p></div>`

  await mail.sendMail({ to, cc, subject: `${deal?.name} — ${month} review: follow-up items`, html })
  const now = new Date().toISOString()
  const newlySent = items.filter(i => i.status === 'open').map(i => i.id)
  if (newlySent.length) await db.from('action_items').update({ status: 'sent', updated_at: now }).in('id', newlySent)
  await db.from('am_reviews').update({ status: 'sent', sent_at: now }).eq('id', review.id)
  return { ok: true, sent: items.length }
}

export async function POST(request, { params }) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.isAllDeals) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const db = adminClient()
  const { data: review } = await db.from('am_reviews').select('*').eq('id', id).maybeSingle()
  if (!review) return NextResponse.json({ error: 'Review not found' }, { status: 404 })

  try {
    const result = body.action === 'approve' ? await approve(db, review, auth, body)
      : body.action === 'send' ? await send(db, review, body)
      : { error: 'Unknown action', status: 400 }
    return NextResponse.json(result, { status: result.status || 200 })
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
