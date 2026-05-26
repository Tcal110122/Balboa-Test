import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth'

const BUCKET = 'partnership-docs'

export async function DELETE(request, { params }) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })
  if (!auth.isAllDeals) return new Response('Forbidden', { status: 403 })

  const { id } = await params
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { data: doc, error: fetchErr } = await admin
    .from('deal_documents')
    .select('file_path')
    .eq('id', id)
    .maybeSingle()

  if (fetchErr || !doc) return new Response('Document not found', { status: 404 })

  await admin.storage.from(BUCKET).remove([doc.file_path])
  await admin.from('deal_documents').delete().eq('id', id)

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
}
