import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, canAccessDeal } from '@/lib/auth'
import supabase from '@/lib/supabase'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null
const money = v => v == null ? 'N/A' : '$' + Math.round(v).toLocaleString()
const pct = v => v == null ? 'N/A' : v.toFixed(1) + '%'

function buildSystemPrompt(dealName, dealType, rr, t12, budget, compData) {
  const lines = [
    `You are a real estate asset management AI assistant for the property "${dealName}" (type: ${dealType || 'conventional'}).`,
    `Answer questions using the data provided. Be concise and precise. Never fabricate numbers.`,
    `Format currency as dollars. Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    `Data available: Rent Roll${t12 ? ', T-12' : ''}${budget ? ', Budget' : ''}${compData?.comps?.length ? ', Comp Set' : ''}.`,
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
    const months = (d.months || []).map(m => m.label || String(m))
    lines.push(`Period: ${d.period || 'N/A'} | Months: ${months.join(', ')}`)

    const addLine = (fig, label) => {
      if (!fig) return
      lines.push(`${label}: T-12 total ${money(fig.total)}`)
      if (fig.vals?.length && months.length) {
        const mo = months.map((m, i) => `${m}: ${money(fig.vals[i])}`).join(' | ')
        lines.push(`  Monthly: ${mo}`)
      }
    }
    addLine(d.totalIncome, 'Total Income')
    addLine(d.totalOpEx,   'Total Operating Expenses')
    addLine(d.noi,         'NOI')

    if (d.totalIncome?.total && d.totalOpEx?.total)
      lines.push(`Expense ratio: ${pct(d.totalOpEx.total / d.totalIncome.total * 100)}`)

    if (d.categories?.length) {
      lines.push('Expense categories:')
      d.categories.forEach(c => lines.push(`  ${c.label || c.name}: ${money(c.total)}`))
    }
  }

  if (budget) {
    lines.push('\n## BUDGET')
    const b = budget.data || budget
    const MON_ORDER = b.monthOrder || ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    const MON_LABEL = { jan:'Jan',feb:'Feb',mar:'Mar',apr:'Apr',may:'May',jun:'Jun',jul:'Jul',aug:'Aug',sep:'Sep',oct:'Oct',nov:'Nov',dec:'Dec' }

    // Budget data lives in b.scorecard.{income|opex|noi}.budget as { jan: N, feb: N, ... }
    const sc = b.scorecard || {}
    const sumMonths = obj => obj ? MON_ORDER.reduce((s, m) => s + (obj[m] ?? 0), 0) : null
    const fmtMonths = obj => obj ? MON_ORDER.filter(m => obj[m] != null).map(m => `${MON_LABEL[m]}: ${money(obj[m])}`).join(' | ') : null

    const budNOI    = sc.noi?.budget
    const budIncome = sc.income?.budget
    const budOpEx   = sc.opex?.budget

    const budNOITotal    = sumMonths(budNOI)
    const budIncomeTotal = sumMonths(budIncome)
    const budOpExTotal   = sumMonths(budOpEx)

    if (budIncomeTotal != null) {
      lines.push(`Total Income: budgeted ${money(budIncomeTotal)} (full year)`)
      const mo = fmtMonths(budIncome); if (mo) lines.push(`  Monthly: ${mo}`)
    }
    if (budOpExTotal != null) {
      lines.push(`Total OpEx: budgeted ${money(budOpExTotal)} (full year)`)
    }
    if (budNOITotal != null) {
      lines.push(`NOI: budgeted ${money(budNOITotal)} (full year)`)
      const mo = fmtMonths(budNOI); if (mo) lines.push(`  Monthly: ${mo}`)
    }
    if (b.currentMonth) lines.push(`Latest closed month: ${MON_LABEL[b.currentMonth] || b.currentMonth}`)

    // Actuals vs budget for closed months
    const actNOI = sc.noi?.actual
    const closedActNOI = actNOI ? MON_ORDER.filter(m => actNOI[m] != null && actNOI[m] !== 0) : []
    if (closedActNOI.length) {
      const actTotal = closedActNOI.reduce((s, m) => s + actNOI[m], 0)
      const budYTD   = closedActNOI.reduce((s, m) => s + (budNOI?.[m] ?? 0), 0)
      const variance = actTotal - budYTD
      lines.push(`NOI YTD actual: ${money(actTotal)} vs budget ${money(budYTD)} → ${variance >= 0 ? '+' : ''}${money(variance)} (${pct(budYTD ? variance / budYTD * 100 : null)})`)
      lines.push(`  Actuals by month: ${closedActNOI.map(m => `${MON_LABEL[m]}: ${money(actNOI[m])}`).join(' | ')}`)
    }
  }

  if (compData?.comps?.length) {
    lines.push('\n## COMP SET')
    lines.push(`${compData.comps.length} comparable communities:`)
    compData.comps.forEach(c => {
      const distStr = c.distance != null ? ` (${Number(c.distance).toFixed(1)} mi)` : ''
      const unitsStr = c.units ? `, ${c.units} units` : ''
      const leasedStr = c.perf?.leasedPct != null ? `, ${pct(c.perf.leasedPct * 100)} leased` : ''
      lines.push(`  ${c.name}${distStr}${unitsStr}${leasedStr}`)
      // Bed-type rows
      if (c.rows?.length) {
        const byBed = {}
        c.rows.forEach(r => {
          if (!r.bed) return
          if (!byBed[r.bed]) byBed[r.bed] = { asking: [], ner: [] }
          if (r.asking != null) byBed[r.bed].asking.push(r.asking)
          const ne = r.netEffective ?? r.nerDirect ?? r.ner
          if (ne != null) byBed[r.bed].ner.push(ne)
        })
        Object.entries(byBed).forEach(([bed, d]) => {
          const askAvg = d.asking.length ? avg(d.asking) : null
          const nerAvg = d.ner.length ? avg(d.ner) : null
          lines.push(`    ${bed}: asking ${money(askAvg)}${nerAvg != null ? `, NER ${money(nerAvg)}` : ''}`)
        })
      }
    })
    // Subject vs comp averages by bed if rent roll available
    if (rr?.units?.length) {
      const beds = {}
      rr.units.forEach(u => {
        const tier = u.tier || 'Unknown'
        if (!beds[tier]) beds[tier] = { ip: [], mk: [] }
        if (u.market != null) beds[tier].mk.push(u.market)
        if (!u.vacant && u.inplace != null) beds[tier].ip.push(u.inplace)
      })
      lines.push('  Subject property by tier vs comp asking averages:')
      Object.entries(beds).forEach(([tier, d]) => {
        const subIP = avg(d.ip), subMK = avg(d.mk)
        // find matching comp bed
        const bedKey = tier.match(/studio/i) ? 'Studio' : tier.match(/1/i) ? '1BR' : tier.match(/2/i) ? '2BR' : tier.match(/3/i) ? '3BR' : null
        let compAsk = null
        if (bedKey) {
          const vals = []
          compData.comps.forEach(c => (c.rows || []).forEach(r => {
            if (r.bed && r.bed.includes(bedKey.replace('BR', '')) && r.asking != null) vals.push(r.asking)
          }))
          compAsk = vals.length ? avg(vals) : null
        }
        lines.push(`    ${tier}: subject in-place ${money(subIP)}, market ${money(subMK)}${compAsk != null ? `, comp avg asking ${money(compAsk)}, spread ${money((subMK ?? 0) - compAsk)}` : ''}`)
      })
    }
  }

  return lines.join('\n')
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return new Response('Unauthorized', { status: 401 })

  let body
  try { body = await request.json() } catch { return new Response('Bad request', { status: 400 }) }

  const { dealId, dealName, dealType, messages, enableCharts, source } = body
  if (!dealId || !messages?.length) return new Response('Bad request', { status: 400 })
  if (!canAccessDeal(auth, dealId)) return new Response('Forbidden', { status: 403 })

  const [rrRow, t12Row, budRow, compRow] = await Promise.all([
    supabase.from('rent_roll_snapshots').select('as_of_date, units').eq('deal_id', dealId).order('as_of_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('t12_snapshots').select('period, data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('budget_snapshots').select('data').eq('deal_id', dealId).order('parsed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('comp_snapshots').select('comps').eq('deal_id', dealId).order('imported_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  let systemPrompt = buildSystemPrompt(dealName || 'this property', dealType || 'conventional', rrRow.data, t12Row.data, budRow.data, compRow.data)

  if (enableCharts) {
    systemPrompt += `\n\n## CHART RESPONSES
When the user asks for a chart, graph, trend, or visualization, respond with a JSON chart spec wrapped in <chart></chart> tags, followed by 1-2 sentences of commentary.

Chart spec format:
<chart>{"type":"line","title":"Chart Title","labels":["Jan 2025","Feb 2025"],"datasets":[{"label":"Series Name","data":[100000,110000],"color":"#2563EB"}]}</chart>

Rules:
- type: "line" for trends over time, "bar" for comparisons, "pie" for breakdowns
- data values must be plain numbers (no $ or commas)
- colors: #2563EB blue, #EF4444 red, #16A34A green, #F59E0B amber, #8B5CF6 purple
- labels must match data array length exactly
- for text-only questions, respond normally with no <chart> tag`
  }
  const userEmail = auth.user.email || auth.user.id
  const question = messages[messages.length - 1]?.content || ''

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
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
          source: source || null,
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
