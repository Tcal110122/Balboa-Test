import { createClient } from '@supabase/supabase-js'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import { notifyDocumentUpload } from '@/lib/email'

const BUCKET = 'partnership-docs'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Resolves emails for all users who have access to a deal (partners + sponsors)
// and fires the notification. Never throws — email failure must not affect uploads.
async function sendDocumentNotificationAsync({ admin, dealId, name, category, uploaderEmail }) {
  try {
    const [{ data: partners }, { data: sponsorOrgs }, { data: deal }] = await Promise.all([
      admin.from('deal_partners').select('org_id').eq('deal_id', dealId),
      admin.from('organizations').select('id').eq('type', 'sponsor'),
      admin.from('deals').select('name').eq('id', dealId).maybeSingle(),
    ])

    const orgIds = [
      ...new Set([
        ...(partners || []).map(p => p.org_id),
        ...(sponsorOrgs || []).map(o => o.id),
      ])
    ]

    const { data: profiles } = await admin.from('profiles').select('id').in('org_id', orgIds)
    const userIds = new Set((profiles || []).map(p => p.id))

    const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 1000 })
    const recipientEmails = users
      .filter(u => userIds.has(u.id) && u.email)
      .map(u => u.email)

    await notifyDocumentUpload({
      dealName: deal?.name || dealId,
      docName: name,
      category,
      uploaderEmail,
      recipientEmails,
    })
  } catch (err) {
    console.error('[email] Document notification failed:', err)
  }
}

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')
  if (!dealId) return new Response('deal_id required', { status: 400 })
  if (!canAccessDeal(auth, dealId)) return new Response('Forbidden', { status: 403 })

  const admin = adminClient()
  const { data, error } = await admin
    .from('deal_documents')
    .select('id, name, category, file_path, file_size, file_type, uploaded_by_email, created_at')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false })

  if (error) return new Response(error.message, { status: 500 })

  // Generate a signed URL for each document (1 hour expiry)
  const docs = await Promise.all((data || []).map(async doc => {
    const { data: signed } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(doc.file_path, 3600)
    return { ...doc, download_url: signed?.signedUrl || null }
  }))

  return new Response(JSON.stringify(docs), { headers: { 'Content-Type': 'application/json' } })
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })
  const email = auth.user.email || ''
  const canUpload = auth.isAllDeals || email.toLowerCase().endsWith('@thebalboagroup.com')
  if (!canUpload) return new Response('Forbidden — upload requires a Balboa Group account', { status: 403 })

  let formData
  try { formData = await request.formData() } catch { return new Response('Bad request', { status: 400 }) }

  const file = formData.get('file')
  const dealId = formData.get('deal_id')
  const category = formData.get('category') || 'Other'
  const name = formData.get('name') || file?.name || 'Document'

  if (!file || !dealId) return new Response('Missing file or deal_id', { status: 400 })
  if (!canAccessDeal(auth, dealId)) return new Response('Forbidden', { status: 403 })

  const admin = adminClient()
  const ext = file.name.split('.').pop().toLowerCase()
  const path = `${dealId}/${Date.now()}_${file.name.replace(/[^a-z0-9._-]/gi, '_')}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type,
    upsert: false,
  })
  if (upErr) return new Response(upErr.message, { status: 500 })

  const { error: dbErr } = await admin.from('deal_documents').insert({
    deal_id: dealId,
    name,
    category,
    file_path: path,
    file_size: file.size,
    file_type: file.type,
    uploaded_by: auth.user.id,
    uploaded_by_email: auth.user.email || auth.user.id,
  })
  if (dbErr) return new Response(dbErr.message, { status: 500 })

  // Fire-and-forget email notification to all deal users
  sendDocumentNotificationAsync({ admin, dealId, name, category, uploaderEmail: auth.user.email || '' })

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}
