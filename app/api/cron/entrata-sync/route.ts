import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { isConfigured, runReport } from '@/lib/entrata-api'
import { mapEntrataRR } from '@/lib/entrata-rr-mapper'

const CRON_SECRET = process.env.CRON_SECRET

// Maps each Entrata property to one of your deals. Fill in once we know the
// Entrata property IDs (from getProperties) and your deal IDs. Until this is
// populated the route is a safe no-op.
//   { entrataPropertyId: '12345', dealId: 'darby-at-briarcliff' }
const PROPERTY_MAP: { entrataPropertyId: string; dealId: string }[] = []

export async function GET(request: Request) {
  // Same auth model as /api/cron/ai-scan
  const authHeader = request.headers.get('authorization')
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Hard guards: do nothing until credentials + mapping are in place.
  if (!isConfigured()) {
    return NextResponse.json({ ok: false, reason: 'Entrata API not configured', synced: [] })
  }
  if (PROPERTY_MAP.length === 0) {
    return NextResponse.json({ ok: false, reason: 'PROPERTY_MAP is empty', synced: [] })
  }

  const asOf = new Date().toISOString().slice(0, 10)
  const synced: Array<Record<string, unknown>> = []

  for (const { entrataPropertyId, dealId } of PROPERTY_MAP) {
    try {
      // CONFIRM: report name + filter keys against live Entrata account.
      const rows = await runReport('Rent Roll', { propertyIds: [entrataPropertyId] })
      const parsed = mapEntrataRR(rows as Record<string, unknown>[], asOf)

      if ('error' in parsed && parsed.error) {
        synced.push({ dealId, ok: false, error: parsed.error })
        continue
      }
      if (!parsed.units?.length) {
        synced.push({ dealId, ok: false, error: 'no units mapped' })
        continue
      }

      // Same upsert shape/onConflict as /api/parse-rentroll — coexists with manual uploads.
      const { error } = await supabase
        .from('rent_roll_snapshots')
        .upsert(
          { deal_id: dealId, as_of_date: parsed.asOf, units: parsed.units },
          { onConflict: 'deal_id,as_of_date' }
        )

      if (error) synced.push({ dealId, ok: false, error: error.message })
      else synced.push({ dealId, ok: true, units: parsed.units.length })
    } catch (err) {
      synced.push({ dealId, ok: false, error: String(err) })
    }
  }

  return NextResponse.json({ ok: true, synced_at: new Date().toISOString(), synced })
}
