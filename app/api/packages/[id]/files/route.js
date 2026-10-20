// GET /api/packages/:id/files -> the package's original files, each with a
// short-lived download link (10 minutes).

import { NextResponse } from 'next/server'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import { adminClient, BUCKET } from '@/lib/packages/intake'

export async function GET(request, { params }) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const db = adminClient()
  const { data: pkg } = await db.from('packages').select('id, deal_id').eq('id', id).maybeSingle()
  if (!pkg) return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  if (!canAccessDeal(auth, pkg.deal_id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: files, error } = await db.from('package_files').select('id, filename, storage_path, size_bytes').eq('package_id', id).order('filename')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!files?.length) return NextResponse.json([])

  const { data: signed, error: signErr } = await db.storage.from(BUCKET).createSignedUrls(files.map(f => f.storage_path), 600)
  if (signErr) return NextResponse.json({ error: signErr.message }, { status: 500 })
  const urlFor = Object.fromEntries((signed || []).map(s => [s.path, s.signedUrl]))

  return NextResponse.json(files.map(f => ({
    // Show the path inside the zip without the zip's own folder name.
    name: f.filename.includes('/') ? f.filename.split('/').slice(1).join('/') : f.filename,
    size_bytes: f.size_bytes,
    url: urlFor[f.storage_path] || null,
  })))
}
