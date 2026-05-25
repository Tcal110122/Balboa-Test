import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import supabase from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
const money = v => v == null ? 'N/A' : '$' + Math.round(v).toLocaleString()
const pct = v => v == null ? 'N/A' : v.toFixed(1) + '%'

function buildSystemPrompt(dealName, dealType, rr, t12, budget) {
  const lines = [
    `You are a real estate asset management AI assistant for the property "${dealName}" (type: ${dealType || 'conventional'}).`,
    `Answer questions using the data provided. Be concise and precise. Never fabricate numbers.`,
    `Format currency as dollars. Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## RENT ROLL DATA',
  ]

  if (rr) {
    const units = rr.units || []
    const occ = units.filter(u => !u.vacant)
    const allMarket = units.filter(u => u.market != null).map(u => u.market)
    const allInplace = occ.filter(u => u.inplace != null).map(u => u.inplace)
    lines.push(`As-of date: ${rr.as_of_date}`)
    lines.push(`Total units: ${units.length} | Occupied: ${occ.length} | Vacant: ${units.length - occ.length} | Occupancy: ${pct(units.length ? occ.length / units.length * 100 : null)}`)
    lines.push(`Avg market rent: ${money(avg(allMarket))} | Avg in-place: ${money(avg(allInplace))} | LtL/unit: ${money(avg(allMarket) != null && avg(allInplace) != null ? avg(allMarket) - avg(allInplace) : null)}`)
    const tiers = {}
    units.forEach(u => {
      const t = u.tier || 'Unknown'
      if (!tiers[t]) tiers[t] = { units: 0, vac: 0, ip: [], mk: [] }
      tiers[t].units++
      if (u.vacant) tiers[t].vac++
      if (u.market != null) tiers[t].mk.push(u.market)
      if (!u.vacant && u.inplace != null) tiers[t].ip.push(u.inplace)
    })
    lines.push('By tier:')
    Object.entries(tiers).forEach(([t, d]) => {
      const aIP = avg(d.ip), aMK = avg(d.mk)
      lines.push(`  ${t}: ${d.units} units, ${pct(d.units ? (d.units - d.vac) / d.units * 100 : null)} occ, market ${money(aMK)}, in-place ${money(aIP)}, LtL ${money(aIP != null && aMK != null ? aMK - aIP : null)}`)
    })
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 90)
    const expiring = occ.filter(u => u.leaseExp && new Date(u.leaseExp) <= cutoff).length
    lines.push(`Leases expiring next 90 days: ${expiring}`)
  } else {
    lines.push('No rent roll data available.')
  }

  if (t12) {
    lines.push('\n## T-12 INCOME STATEMENT')
    const d = t12.data || t12
    lines.push(`Period: ${d.period || 'N/A'}`)
    if (d.noi) lines.push(`NOI: ${money(d.noi.total)}`)
    if (d.revenue) lines.push(`Total revenue: ${money(d.revenue.total)}`)
    if (d.expenses) lines.push(`Total expenses: ${money(d.expenses.total)}`)
    if (d.noi && d.revenue && d.revenue.total)
      lines.push(`NOI margin: ${pct(d.noi.total / d.revenue.total * 100)}`)
  }

  if (budget) {
    lines.push('\n## BUDGET')
    const b = budget.data || budget
    if (b.noi) lines.push(`Budgeted NOI: ${money(b.noi.total)}`)
    if (b.revenue) lines.push(`Budgeted revenue: ${money(b.revenue.total)}`)
    if (t12 && b.noi?.total != null) {
      const t = t12.data || t12
      if (t.noi?.total != null) {
        const v = t.noi.total - b.noi.total
        lines.push(`NOI vs budget: ${v >= 0 ? '+' : ''}${money(v)} (${pct(b.noi.total ? v / b.noi.total * 100 : null)})`)
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

  const [rrRow, t12Row, budRow] = await Promise.all([
    supabase.from('rent_roll_snapshots').select('as_of_date, units').eq('deal_id', dealId).order('as_of_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('t12_snapshots').select('period, data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('budget_snapshots').select('data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const systemPrompt = buildSystemPrompt(dealName || 'this property', dealType || 'conventional', rrRow.data, t12Row.data, budRow.data)
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
          deal_id: dealId,
          deal_name: dealName || null,
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
