import { NextResponse } from 'next/server'
import { parseRentRoll } from '@/lib/rentroll-parser'
import { parseOneSiteRR } from '@/lib/onesite-rr-parser'
import { parseEntrataRR } from '@/lib/entrata-rr-parser'
import * as XLSX from 'xlsx'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

function detectFormat(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 20 })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // Brand-name detection
  for (const row of grid) {
    for (const cell of row) {
      const s = String(cell)
      if (/onesite/i.test(s)) return 'onesite'
      if (/entrata/i.test(s)) return 'entrata'
    }
  }

  // Column-pattern detection: Entrata has a single header row with Unit + Status + a rent column
  for (let i = 0; i < Math.min(20, grid.length); i++) {
    const row = (grid[i] || []).map(v => String(v || '').toLowerCase().trim())
    const hasUnit   = row.some(v => /^unit\s*#?$|^unit\s*number$/.test(v))
    const hasStatus = row.some(v => /^status$/.test(v))
    const hasRent   = row.some(v => /rent|market/.test(v))
    if (hasUnit && hasStatus && hasRent) return 'entrata'
  }

  return 'yardi'
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    const dealId = formData.get('deal_id')

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    if (!dealId) return NextResponse.json({ error: 'No deal_id provided' }, { status: 400 })
    if (!canAccessDeal(auth, dealId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const format = detectFormat(buffer)
    const parsed = format === 'onesite' ? parseOneSiteRR(buffer)
                 : format === 'entrata' ? parseEntrataRR(buffer)
                 : parseRentRoll(buffer)

    if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })
    if (!parsed.units?.length) {
      return NextResponse.json(
        { error: 'No units found. Make sure this is a Yardi, OneSite, or Entrata rent roll export.' },
        { status: 400 }
      )
    }

    const { error } = await supabase
      .from('rent_roll_snapshots')
      .upsert(
        { deal_id: dealId, as_of_date: parsed.asOf, units: parsed.units },
        { onConflict: 'deal_id,as_of_date' }
      )

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      success: true,
      asOf: parsed.asOf,
      unitCount: parsed.units.length,
      occupied: parsed.units.filter(u => !u.vacant).length,
      vacant: parsed.units.filter(u => u.vacant).length,
      dupCount: parsed.dupCount,
      reviewCount: parsed.reviewCount
    })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
