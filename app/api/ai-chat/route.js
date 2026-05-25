import Anthropic from '@anthropic-ai/sdk'
import { requireAuth } from '@/lib/auth'
import supabase from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
const money = v => v == null ? 'N/A' : '$' + Math.round(v).toLocaleString()
const pct = v => v == null ? 'N/A' : v.toFixed(1) + '%'

function summariseProperty(deal, rr, t12, budget) {
  const lines = [`### ${deal.name} (${deal.market || deal.address || 'N/A'}, ${deal.type || 'conventional'})`]

  if (rr) {
    const units = rr.units || []
    const occ = units.filter(u => !u.vacant)
    const allMarket = units.filter(u => u.market != null).map(u => u.market)
    const allInplace = occ.filter(u => u.inplace != null).map(u => u.inplace)
    lines.push(`Rent roll as of ${rr.as_of_date}: ${units.length} units, ${pct(units.length ? occ.length / units.length * 100 : null)} occ`)
    lines.push(`Avg market: ${money(avg(allMarket))} | Avg in-place: ${money(avg(allInplace))} | LtL/unit: ${money(avg(allMarket) != null && avg(allInplace) != null ? avg(allMarket) - avg(allInplace) : null)}`)

    const tiers = {}
    units.forEach(u => {
      const t = u.tier || 'Unknown'
      if (!tiers[t]) tiers[t] = { units: 0, vac: 0, ip: [], mk: [] }
      tiers[t].units++
      if (u.vacant) tiers[t].vac++
      if (u.market != null) tiers[t].mk.push(u.market)
      if (!u.vacant && u.inplace != null) tiers[t].ip.push(u.inplace)
    })
    Object.entries(tiers).forEach(([t, d]) => {
      const aIP = avg(d.ip), aMK = avg(d.mk)
      lines.push(`  ${t}: ${d.units} units, ${pct(d.units ? (d.units - d.vac) / d.units * 100 : null)} occ, mkt ${money(aMK)}, in-place ${money(aIP)}, LtL ${money(aIP != null && aMK != null ? aMK - aIP : null)}`)
    })

    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 90)
    const expiring = occ.filter(u => u.leaseExp && new Date(u.leaseExp) <= cutoff).length
    lines.push(`  Leases expiring next 90 days: ${expiring}`)
  } else {
    lines.push('  No rent roll data.')
  }

  if (t12) {
    const d = t12.data || t12
    const noiLine = d.noi ? `NOI ${money(d.noi.total)}` : ''
    const revLine = d.revenue ? `revenue ${money(d.revenue.total)}` : ''
    const margin = d.noi && d.revenue && d.revenue.total ? d.noi.total / d.revenue.total * 100 : null
    lines.push(`  T-12 (${d.period || 'N/A'}): ${[noiLine, revLine, margin != null ? `margin ${pct(margin)}` : ''].filter(Boolean).join(' | ')}`)

    if (budget) {
      const b = budget.data || budget
      if (d.noi?.total != null && b.noi?.total != null) {
        const varAmt = d.noi.total - b.noi.total
        lines.push(`  Budget NOI ${money(b.noi.total)} | Variance ${varAmt >= 0 ? '+' : ''}${money(varAmt)} (${pct(b.noi.total ? varAmt / b.noi.total * 100 : null)})`)
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

  const { messages } = body
  if (!messages?.length) return new Response('Bad request', { status: 400 })

  // Fetch all deals this user can access
  let dealsQuery = supabase.from('deals').select('id, name, market, address, type').order('name')
  if (!auth.isAllDeals) {
    if (!auth.allowedDealIds?.length) return new Response('No deals', { status: 403 })
    dealsQuery = dealsQuery.in('id', auth.allowedDealIds)
  }
  const { data: deals } = await dealsQuery
  if (!deals?.length) return new Response('No deals', { status: 403 })

  const dealIds = deals.map(d => d.id)

  // Fetch latest rent roll, T-12, and budget for every deal in parallel
  const [rrRows, t12Rows, budRows] = await Promise.all([
    supabase.from('rent_roll_snapshots').select('deal_id, as_of_date, units').in('deal_id', dealIds).order('as_of_date', { ascending: false }),
    supabase.from('t12_snapshots').select('deal_id, period, data').in('deal_id', dealIds).order('parsed_at', { ascending: false }),
    supabase.from('budget_snapshots').select('deal_id, data').in('deal_id', dealIds).order('parsed_at', { ascending: false }),
  ])

  // Keep only the latest row per deal
  const latest = (rows, key = 'deal_id') => {
    const seen = new Set(); const out = {}
    ;(rows.data || []).forEach(r => { if (!seen.has(r[key])) { seen.add(r[key]); out[r[key]] = r } })
    return out
  }
  const rrByDeal = latest(rrRows)
  const t12ByDeal = latest(t12Rows)
  const budByDeal = latest(budRows)

  const portfolioSummary = deals.map(d =>
    summariseProperty(d, rrByDeal[d.id], t12ByDeal[d.id], budByDeal[d.id])
  ).join('\n\n')

  const systemPrompt = [
    `You are a real estate asset management AI for a portfolio of ${deals.length} properties.`,
    `Answer questions using the data below. Be concise and precise. Never fabricate numbers.`,
    `Format currency as dollars. Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## PORTFOLIO DATA',
    portfolioSummary,
  ].join('\n')

  const userEmail = auth.user.email || auth.user.id
  const question = messages[messages.length - 1]?.content || ''

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
        const finalMsg = await stream.finalMessage()
        const tokensIn = finalMsg.usage?.input_tokens ?? 0
        const tokensOut = finalMsg.usage?.output_tokens ?? 0
        supabase.from('ai_chat_logs').insert({
          user_id: auth.user.id,
          user_email: userEmail,
          deal_id: null,
          deal_name: 'portfolio',
          question,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
        }).then(() => {}).catch(() => {})
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
