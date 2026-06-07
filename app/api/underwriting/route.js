import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/auth'
import { parseT12 } from '@/lib/t12-parser'
import { parseComparisonT12 } from '@/lib/comparison-t12-parser'
import * as XLSX from 'xlsx'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

function detectT12Format(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 3, cellDates: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
    const row0 = grid[0] || []
    const row1 = grid[1] || []
    const isDateLike = v => v instanceof Date || (typeof v === 'number' && v > 40000 && v < 80000)
    const hasDates = row0.some(isDateLike)
    const hasActualBudget = row1.some(v => typeof v === 'string' && /^(actual|budget)$/i.test(String(v).trim()))
    if (hasDates && hasActualBudget) return 'comparison'
  } catch (_) {}
  return 'standard'
}

// Assess parse quality and return status + notes
function assessParse(parsed) {
  const notes = []
  if (!parsed || parsed.error) return { status: 'failed', notes: [parsed?.error || 'Parser returned no data'] }

  if (!parsed.totalIncome?.total)  notes.push('Total Income not found')
  if (!parsed.totalOpEx?.total && !(parsed.categories?.length)) notes.push('Operating expenses not found')
  if (!parsed.noi?.total)          notes.push('NOI not found — will be derived if Income and OpEx present')
  if (!parsed.categories?.length)  notes.push('Expense category breakdown missing')
  if (!parsed.potentialRent?.total && !parsed.incomeLines?.length) notes.push('Income line detail missing')

  if (notes.filter(n => !n.includes('derived')).length === 0) return { status: 'ok', notes: [] }
  // If we at least have total income and some expenses it's usable but partial
  // Partial if we got at least some useful numbers
  if (parsed.totalIncome?.total || parsed.noi?.total || parsed.categories?.length >= 3)
    return { status: 'partial', notes }
  return { status: 'failed', notes }
}

// GET — list all underwriting deals (all authenticated users can view)
export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const market = searchParams.get('market')
  const type   = searchParams.get('type')
  const year   = searchParams.get('data_year')

  const admin = adminClient()
  let q = admin
    .from('underwriting_deals')
    .select('id, name, market, type, unit_count, data_year, t12_period, parse_status, parse_notes, source, created_at, t12_data')
    .order('data_year', { ascending: false })
    .order('name')

  if (market) q = q.eq('market', market)
  if (type)   q = q.eq('type', type)
  if (year)   q = q.eq('data_year', parseInt(year))

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data || [])
}

// POST — add a deal by uploading a T-12
export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Require Balboa staff to add deals
  const isStaff = auth.isAllDeals ||
    (auth.user.email || '').toLowerCase().endsWith('@thebalboagroup.com')
  if (!isStaff) return NextResponse.json({ error: 'Forbidden — Balboa Group account required' }, { status: 403 })

  try {
    const formData = await request.formData()
    const file      = formData.get('file')
    const name      = formData.get('name')
    const market    = formData.get('market') || ''
    const type      = formData.get('type')  || 'conventional'
    const unitCount = parseInt(formData.get('unit_count') || '0') || null
    const dataYear  = parseInt(formData.get('data_year')  || '0') || new Date().getFullYear()

    if (!file) return NextResponse.json({ error: 'No T-12 file provided' }, { status: 400 })
    if (!name) return NextResponse.json({ error: 'Deal name required' }, { status: 400 })

    const buffer = Buffer.from(await file.arrayBuffer())
    const fmt    = detectT12Format(buffer)

    // Try to parse — but always save regardless of result
    let parsed = null
    try {
      parsed = fmt === 'comparison' ? parseComparisonT12(buffer) : parseT12(buffer)
    } catch (parseErr) {
      parsed = { error: parseErr.message }
    }

    const { status: parseStatus, notes: parseNotes } = assessParse(parsed)

    const admin = adminClient()
    const { data, error } = await admin
      .from('underwriting_deals')
      .insert({
        name,
        market,
        type,
        unit_count:   unitCount,
        data_year:    dataYear,
        t12_period:   parsed?.period || null,
        t12_data:     parseStatus !== 'failed' ? parsed : null,
        parse_status: parseStatus,
        parse_notes:  parseNotes,
        source:       'upload',
        created_by:   auth.user.id,
      })
      .select('id, name, market, type, unit_count, data_year, t12_period, parse_status, parse_notes')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, deal: data, parseStatus, parseNotes })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// DELETE — remove a deal
export async function DELETE(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const isStaff = auth.isAllDeals ||
    (auth.user.email || '').toLowerCase().endsWith('@thebalboagroup.com')
  if (!isStaff) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const admin = adminClient()
  const { error } = await admin.from('underwriting_deals').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
