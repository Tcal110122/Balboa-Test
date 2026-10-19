// Loads everything a monthly review needs from Supabase.

import { accountsToExplain } from './checks.js'

function monthsBack(period, n) {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 - (n - 1), 1)).toISOString().slice(0, 10)
}

async function all(q, label) {
  const { data, error } = await q
  if (error) throw new Error(`${label}: ${error.message}`)
  return data || []
}

// Supabase returns at most 1,000 rows per request, so page through.
// makeQuery must return a fresh, ordered query each call.
async function paged(makeQuery, label) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999)
    if (error) throw new Error(`${label}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < 1000) return out
  }
}

export async function latestParsedPeriod(db, dealId) {
  const { data } = await db.from('packages').select('period').eq('deal_id', dealId).eq('status', 'parsed')
    .order('period', { ascending: false }).limit(1).maybeSingle()
  return data?.period || null
}

export async function loadReviewInput(db, dealId, period) {
  const { data: deal, error } = await db.from('deals').select('id, name, market, type, unit_count, bed_count, property_manager').eq('id', dealId).maybeSingle()
  if (error || !deal) throw new Error(`Deal ${dealId} not found`)

  const from = monthsBack(period, 12)
  const [gl, balance, beds, pkg, openItems, prior] = await Promise.all([
    // gl_monthly has ~170 accounts x 12 months for a typical property.
    paged(() => db.from('gl_monthly').select('period, account_code, account_name, account_group, section, actual, budget, ytd_actual, ytd_budget, annual_budget, manager_note')
      .eq('deal_id', dealId).gte('period', from).lte('period', period).order('period').order('account_code'), 'gl_monthly'),
    all(db.from('balance_sheet').select('account_code, account_name, balance').eq('deal_id', dealId).eq('period', period), 'balance_sheet'),
    paged(() => db.from('bed_snapshots').select('unit, unit_type, market_rent, potential_rent, days_vacant, vacancy_loss').eq('deal_id', dealId).eq('period', period).order('unit'), 'bed_snapshots'),
    db.from('packages').select('id, format, summary').eq('deal_id', dealId).eq('period', period).eq('status', 'parsed')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    all(db.from('action_items').select('id, opened_period, title, ask, at_stake, owner, status, manager_response, due_date')
      .eq('deal_id', dealId).neq('status', 'resolved').order('opened_period'), 'action_items'),
    db.from('am_reviews').select('period, content').eq('deal_id', dealId).lt('period', period).in('status', ['approved', 'sent'])
      .order('period', { ascending: false }).limit(1).maybeSingle(),
  ])

  return { deal, period, gl, balance, beds, package: pkg.data || null, openItems, priorReview: prior.data || null }
}

// The largest transactions behind the accounts the review will discuss.
export async function loadGlDetail(db, dealId, period, flags, perAccount = 12) {
  // Plus accrued expenses: lease breaks and other one-offs often show up there.
  const accrued = (flags.balance_sheet?.accrued || []).map(a => a.account_code)
  const codes = [...new Set([...accountsToExplain(flags), ...accrued])]
  if (!codes.length) return {}
  const rows = await paged(() => db.from('gl_detail').select('account_code, txn_date, txn_type, memo, unit, counterparty, amount')
    .eq('deal_id', dealId).eq('period', period).in('account_code', codes).order('id'), 'gl_detail')
  return groupDetail(rows, codes, perAccount)
}

export function groupDetail(rows, codes, perAccount = 12) {
  const out = {}
  for (const code of codes) {
    const lines = rows.filter(r => r.account_code === code)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, perAccount)
      .map(r => ({ date: r.txn_date, type: r.txn_type, memo: r.memo, unit: r.unit, counterparty: r.counterparty, amount: r.amount }))
    if (lines.length) out[code] = lines
  }
  return out
}
