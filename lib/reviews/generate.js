// Builds (or rebuilds) the draft review for one deal and month.

import { runChecks } from './checks.js'
import { loadReviewInput, loadGlDetail, latestParsedPeriod } from './data.js'
import { draftReview } from './draft.js'

export async function generateReview(db, dealId, period = null) {
  period = period || (await latestParsedPeriod(db, dealId))
  if (!period) throw new Error('No parsed package for this deal yet')

  const input = await loadReviewInput(db, dealId, period)
  const flags = runChecks({ period, bedCount: input.deal.bed_count, gl: input.gl, balance: input.balance, beds: input.beds })
  const glDetail = await loadGlDetail(db, dealId, period, flags)
  const { content, model, usage } = await draftReview({ ...input, flags, glDetail })

  // Approved or sent reviews are kept; an unapproved draft for the month is replaced.
  await db.from('am_reviews').delete().eq('deal_id', dealId).eq('period', period).eq('status', 'draft')
  const { data, error } = await db.from('am_reviews').insert({
    deal_id: dealId, period, package_id: input.package?.id || null, status: 'draft',
    flags, content: { ...content, usage }, model,
  }).select('id, deal_id, period, status, created_at').single()
  if (error) throw new Error(`am_reviews: ${error.message}`)
  return data
}

// Parsed packages that don't have a review yet (newest first).
export async function packagesNeedingReview(db, limit = 1) {
  const { data: pkgs } = await db.from('packages').select('id, deal_id, period').eq('status', 'parsed')
    .not('deal_id', 'is', null).order('created_at', { ascending: false }).limit(25)
  const out = []
  for (const p of pkgs || []) {
    const { data: r } = await db.from('am_reviews').select('id').eq('deal_id', p.deal_id).eq('period', p.period).limit(1).maybeSingle()
    if (!r && !out.some(o => o.deal_id === p.deal_id && o.period === p.period)) out.push(p)
    if (out.length >= limit) break
  }
  return out
}
