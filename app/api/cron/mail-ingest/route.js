// Checks reports@thebalboagroup.com for manager packages and ingests them.
//
// Runs on the Vercel cron in vercel.json, and can be triggered by a
// signed-in sponsor user (e.g. a "Check now" button) via GET.
//
// Each message in the Inbox is processed once, then moved to
// "Processed" (parsed fine) or "Needs review" (rejected sender, no
// attachments, unrecognized format, unmatched deal, or an error).

import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import * as mail from '@/lib/packages/graph'
import { adminClient, expandAttachments, ingestPackage, isAllowedSender, loadAliases } from '@/lib/packages/intake'

export const maxDuration = 300

const PER_RUN = 5

async function authorized(request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') === `Bearer ${secret}`) return true
  const auth = await requireAuth(request).catch(() => null)
  return Boolean(auth?.isAllDeals)
}

async function processMessage(db, aliases, m) {
  const from = m.from?.emailAddress?.address || ''
  const base = {
    graph_message_id: m.id,
    internet_message_id: m.internetMessageId,
    from_address: from,
    subject: m.subject,
    received_at: m.receivedDateTime,
  }

  // Same email seen before (e.g. a move failed last run): just file it.
  const { data: seen } = await db.from('inbound_messages').select('id, status').eq('internet_message_id', m.internetMessageId).maybeSingle()
  if (seen && seen.status !== 'failed') {
    await mail.moveMessage(m.id, seen.status === 'processed' ? 'Processed' : 'Needs review')
    return { subject: m.subject, status: 'already_seen' }
  }

  const { data: row, error } = seen
    ? await db.from('inbound_messages').update({ ...base, status: 'received', error: null }).eq('id', seen.id).select('id').single()
    : await db.from('inbound_messages').insert(base).select('id').single()
  if (error) throw new Error(`inbound_messages: ${error.message}`)

  const finish = async (status, folder, extra = {}) => {
    await db.from('inbound_messages').update({ status, error: extra.error || null }).eq('id', row.id)
    await mail.moveMessage(m.id, folder)
    return { subject: m.subject, from, status, ...extra }
  }

  if (!isAllowedSender(from)) return finish('rejected_sender', 'Needs review', { error: `Sender ${from} is not on the allowed list` })
  if (!m.hasAttachments) return finish('no_attachments', 'Needs review')

  try {
    const atts = await mail.listAttachments(m.id)
    const files = []
    const skipped = []
    for (const a of atts) {
      if (a.isInline) continue
      const type = a['@odata.type'] || '#microsoft.graph.fileAttachment'
      if (type !== '#microsoft.graph.fileAttachment') { skipped.push(a.name); continue } // attached emails / cloud links
      files.push({ name: a.name, contentType: a.contentType, isInline: false, buffer: await mail.downloadAttachment(m.id, a.id) })
    }
    const expanded = await expandAttachments(files)
    if (!expanded.length) return finish('no_attachments', 'Needs review', skipped.length ? { error: `Attached emails aren't supported yet: ${skipped.join(', ')}` } : {})

    const result = await ingestPackage(db, { files: expanded, message: { id: row.id, subject: m.subject }, aliases })
    const ok = result.status === 'parsed' || result.status === 'duplicate'
    return finish('processed', ok ? 'Processed' : 'Needs review', { package: result })
  } catch (e) {
    await db.from('inbound_messages').update({ status: 'failed', error: e.message }).eq('id', row.id)
    // First failure: leave it in the Inbox to retry next run. Second: park it
    // so it can't block newer packages.
    if (seen?.status === 'failed') await mail.moveMessage(m.id, 'Needs review').catch(() => {})
    return { subject: m.subject, from, status: 'failed', error: e.message }
  }
}

export async function GET(request) {
  if (!(await authorized(request))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!mail.isConfigured()) return NextResponse.json({ ok: false, reason: 'Mailbox not configured (MS_* env vars)' })

  const db = adminClient()
  const aliases = await loadAliases(db)
  const messages = await mail.listInboxMessages(PER_RUN)

  const results = []
  for (const m of messages) {
    try {
      results.push(await processMessage(db, aliases, m))
    } catch (e) {
      results.push({ subject: m.subject, status: 'failed', error: e.message })
    }
  }
  return NextResponse.json({ ok: true, checked: messages.length, results })
}
