// POST /api/packages/:id/reparse — re-read a stored package (sponsor only).

import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { adminClient, reparsePackage } from '@/lib/packages/intake'

export const maxDuration = 300

export async function POST(request, { params }) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.isAllDeals) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  try {
    return NextResponse.json(await reparsePackage(adminClient(), id))
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
