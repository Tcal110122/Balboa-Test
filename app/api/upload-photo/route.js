import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth'

const BUCKET = 'property-photos'

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })
  if (!auth.isAllDeals) return new Response('Forbidden — only sponsor accounts can update property photos', { status: 403 })

  let formData
  try { formData = await request.formData() } catch { return new Response('Bad request', { status: 400 }) }

  const file = formData.get('file')
  const dealId = formData.get('deal_id')
  if (!file || !dealId) return new Response('Missing file or deal_id', { status: 400 })

  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!allowed.includes(file.type)) return new Response('Only JPEG, PNG, WebP or GIF allowed', { status: 400 })

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const ext = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]
  const path = `${dealId}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())

  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: file.type,
    upsert: true,
  })
  if (upErr) return new Response(upErr.message, { status: 500 })

  const { data: { publicUrl } } = admin.storage.from(BUCKET).getPublicUrl(path)

  const { error: dbErr } = await admin.from('deals').update({ photo_url: publicUrl }).eq('id', dealId)
  if (dbErr) return new Response(dbErr.message, { status: 500 })

  return new Response(JSON.stringify({ url: publicUrl }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
