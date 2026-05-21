import { NextResponse } from 'next/server'
import supabase from '@/lib/supabase'
import { requireAuth, canAccessDeal } from '@/lib/auth'

const normName = s => String(s).toLowerCase()
  .replace(/apartments?|the |at |on |\s+/g, '')
  .replace(/[^a-z0-9]/g, '')

export async function GET(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const dealId = searchParams.get('deal_id')

  if (dealId && !canAccessDeal(auth, dealId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let query = supabase
    .from('comp_snapshots')
    .select('deal_id, comps, count')
    .order('imported_at', { ascending: false })
    .limit(1)

  if (dealId) query = query.eq('deal_id', dealId)

  const { data, error } = await query.single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })

  // Enrich comps: for any comp whose name fuzzy-matches a portfolio deal,
  // fill in occupancy/leased metrics from that deal's latest rent roll.
  try {
    const dealQuery = supabase.from('deals').select('id, name')
    const { data: deals } = auth.isAllDeals
      ? await dealQuery
      : await dealQuery.in('id', auth.allowedDealIds ?? [])

    if (deals?.length && data.comps?.length) {
      // Fetch latest rent roll snapshot per deal (take first after ordering desc)
      const dealIds = deals.map(d => d.id)
      const { data: rrRows } = await supabase
        .from('rent_roll_snapshots')
        .select('deal_id, units')
        .in('deal_id', dealIds)
        .order('as_of_date', { ascending: false })

      // Dedupe: first row per deal_id
      const rrByDeal = {}
      ;(rrRows || []).forEach(r => { if (!rrByDeal[r.deal_id]) rrByDeal[r.deal_id] = r.units })

      // Build norm-name → occupancy map
      const occByNorm = {}
      deals.forEach(d => {
        const units = rrByDeal[d.id]
        if (!units?.length) return
        const total = units.length
        const vacantCount = units.filter(u => u.vacant && !u.preLeased).length
        const preLeasedCount = units.filter(u => u.preLeased).length
        const occupiedCount = total - units.filter(u => u.vacant).length
        occByNorm[normName(d.name)] = {
          occupancy: occupiedCount / total,                          // physical
          leasedPct: (occupiedCount + preLeasedCount) / total,       // signed leases
          exposure:  vacantCount / total,                            // unleased vacant
          totalUnits: total,
        }
      })

      // Enrich each comp whose perf lacks leased/exposure data
      data.comps = data.comps.map(comp => {
        const nn = normName(comp.name)
        const match = Object.keys(occByNorm).find(k => k === nn || k.includes(nn) || nn.includes(k))
        if (!match) return comp
        const occ = occByNorm[match]
        // Only backfill — don't overwrite data already present from source
        const p = comp.perf || {}
        comp.perf = {
          ...p,
          leasedPct: p.leasedPct ?? occ.leasedPct,
          exposure:  p.exposure  ?? occ.exposure,
          totalUnits: p.totalUnits ?? occ.totalUnits,
        }
        return comp
      })
    }
  } catch (_) {
    // enrichment is best-effort; return raw data on failure
  }

  return NextResponse.json(data)
}
