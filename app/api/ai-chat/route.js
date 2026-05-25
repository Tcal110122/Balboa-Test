import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import supabase from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function money(v) {
  if (v == null) return 'N/A'
  return '$' + Math.round(v).toLocaleString()
}
function pct(v) {
  if (v == null) return 'N/A'
  return v.toFixed(1) + '%'
}

function buildSystemPrompt(dealName, dealType, rr, t12, budget) {
  const lines = [
    `You are a real estate asset management AI assistant for the property "${dealName}" (type: ${dealType || 'conventional'}).`,
    `You have access to the property's live operational data. Answer questions concisely and accurately using the data provided.`,
    `Format currency as dollars. If data is unavailable, say so — never fabricate numbers.`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## RENT ROLL DATA',
  ]

  if (rr) {
    const units = rr.units || []
    const occ = units.filter(u => !u.vacant)
    const allMarket = units.filter(u => u.market != null).map(u => u.market)
    const allInplace = occ.filter(u => u.inplace != null).map(u => u.inplace)
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null

    lines.push(`As-of date: ${rr.as_of_date}`)
    lines.push(`Total units: ${units.length} | Occupied: ${occ.length} | Vacant: ${units.length - occ.length} | Occupancy: ${pct(units.length ? occ.length / units.length * 100 : null)}`)
    lines.push(`Avg market rent: ${money(avg(allMarket))} | Avg in-place rent: ${money(avg(allInplace))} | Loss-to-lease/unit: ${money(avg(allMarket) != null && avg(allInplace) != null ? avg(allMarket) - avg(allInplace) : null)}`)

    // Tier breakdown
    const tiers = {}
    units.forEach(u => {
      const t = u.tier || 'Unknown'
      if (!tiers[t]) tiers[t] = { units: 0, vac: 0, ip: [], mk: [] }
      tiers[t].units++
      if (u.vacant) tiers[t].vac++
      if (u.market != null) tiers[t].mk.push(u.market)
      if (!u.vacant && u.inplace != null) tiers[t].ip.push(u.inplace)
    })
    lines.push('\nBy tier:')
    Object.entries(tiers).forEach(([t, d]) => {
      const aIP = avg(d.ip), aMK = avg(d.mk)
      lines.push(`  ${t}: ${d.units} units, ${pct(d.units ? (d.units - d.vac) / d.units * 100 : null)} occ, market ${money(aMK)}, in-place ${money(aIP)}, LtL ${money(aIP != null && aMK != null ? aMK - aIP : null)}`)
    })

    // Upcoming expirations (next 90 days)
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 90)
    const expiring = occ.filter(u => u.leaseExp && new Date(u.leaseExp) <= cutoff).length
    lines.push(`\nLeases expiring in next 90 days: ${expiring}`)
  } else {
    lines.push('No rent roll data available.')
  }

  if (t12) {
    lines.push('\n## T-12 INCOME STATEMENT')
    const d = t12.data || t12
    lines.push(`Period: ${d.period || 'N/A'}`)
    if (d.noi) lines.push(`NOI: ${money(d.noi.total)} (${d.noi.months || 12} months)`)
    if (d.revenue) lines.push(`Total revenue: ${money(d.revenue.total)}`)
    if (d.expenses) lines.push(`Total expenses: ${money(d.expenses.total)}`)
    if (d.noi && d.revenue) {
      const margin = d.revenue.total ? d.noi.total / d.revenue.total * 100 : null
      lines.push(`NOI margin: ${pct(margin)}`)
    }
  }

  if (budget) {
    lines.push('\n## BUDGET')
    const d = budget.data || budget
    if (d.noi) lines.push(`Budgeted NOI: ${money(d.noi.total)}`)
    if (d.revenue) lines.push(`Budgeted revenue: ${money(d.revenue.total)}`)
    if (d.expenses) lines.push(`Budgeted expenses: ${money(d.expenses.total)}`)
    // variance vs T-12 if both present
    if (t12 && budget) {
      const t = t12.data || t12, b = d
      if (t.noi?.total != null && b.noi?.total != null) {
        const varAmt = t.noi.total - b.noi.total
        lines.push(`NOI vs budget: ${varAmt >= 0 ? '+' : ''}${money(varAmt)} (${pct(b.noi.total ? varAmt / b.noi.total * 100 : null)})`)
      }
    }
  }

  return lines.join('\n')
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })

  let body
  try { body = await request.json() } catch { return new Response('Bad request', { status: 400 }) }

  const { dealId, dealName, dealType, messages } = body
  if (!dealId || !messages?.length) return new Response('Bad request', { status: 400 })
  if (!canAccessDeal(auth, dealId)) return new Response('Forbidden', { status: 403 })

  // Fetch deal data in parallel
  const [rrRow, t12Row, budRow] = await Promise.all([
    supabase.from('rent_roll_snapshots').select('as_of_date, units').eq('deal_id', dealId).order('as_of_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('t12_snapshots').select('period, data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('budget_snapshots').select('data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const systemPrompt = buildSystemPrompt(
    dealName || 'this property',
    dealType || 'conventional',
    rrRow.data,
    t12Row.data,
    budRow.data
  )

  // Stream Claude's response back
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  })

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
            controller.enqueue(new TextEncoder().encode(chunk.delta.text))
          }
        }
      } catch (err) {
        controller.enqueue(new TextEncoder().encode('\n\n[Error: ' + err.message + ']'))
      } finally {
        controller.close()
      }
    }
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
  })
}
