// Deterministic checks behind the monthly asset-management review.
//
// Code computes every number; Claude (lib/reviews/draft.js) only
// interprets them. Pure functions — input is plain rows, so they can be
// tested without a database.
//
// input = {
//   period: 'YYYY-MM-01',
//   bedCount: number | null,
//   gl: [{ period, account_code, account_name, account_group, section,
//          actual, budget, ytd_actual, ytd_budget, annual_budget, manager_note }],
//   balance: [{ account_code, account_name, balance }],          // this month
//   beds: [{ unit, unit_type, market_rent, potential_rent, days_vacant, vacancy_loss }],
// }

export const THRESHOLDS = {
  mtdDollars: 1000,      // a monthly variance worth explaining
  mtdPct: 0.10,
  ytdDollars: 5000,
  ytdPct: 0.10,
  trendPct: 0.30,        // trailing 3 months vs the months before
  trendDollarsPerMonth: 800,
  trendMinT12: 10000,
  smallNote: 500,        // notes written on variances smaller than this
  unbudgetedYtd: 10000,
}

const round = n => (n === null || n === undefined ? null : Math.round(n))
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0)
const isIncome = l => l.account_group === 'Income'
const isOpex = l => l.account_group === 'Operating Expenses'
const isOperating = l => isIncome(l) || isOpex(l)

// Positive = good for NOI, for both income and expense lines.
export function favorable(line, actual = line.actual, budget = line.budget) {
  if (actual === null || budget === null) return null
  return isIncome(line) ? actual - budget : budget - actual
}

function monthsBack(period, n) {
  const [y, m] = period.split('-').map(Number)
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

// account_code -> { line (this month), series: { period: actual } }
function byAccount(gl, period) {
  const map = new Map()
  for (const r of gl) {
    if (!map.has(r.account_code)) map.set(r.account_code, { series: {} })
    const a = map.get(r.account_code)
    a.series[r.period] = r.actual
    if (r.period === period) a.line = r
    if (!a.meta || r.period === period) a.meta = r
  }
  return map
}

// ---------------------------------------------------------------

function noiSummary(cur, months, accounts) {
  const noi = rows => sum(rows.filter(isIncome), r => r.actual) - sum(rows.filter(isOpex), r => r.actual)
  const noiBudget = rows => sum(rows.filter(isIncome), r => r.budget) - sum(rows.filter(isOpex), r => r.budget)
  const noiYtd = rows => sum(rows.filter(isIncome), r => r.ytd_actual) - sum(rows.filter(isOpex), r => r.ytd_actual)
  const noiYtdBudget = rows => sum(rows.filter(isIncome), r => r.ytd_budget) - sum(rows.filter(isOpex), r => r.ytd_budget)
  const opexYtdVar = sum(cur.filter(isOpex), r => (r.ytd_budget || 0) - (r.ytd_actual || 0))

  const monthly = months.map(p => {
    let inc = 0, exp = 0
    for (const a of accounts.values()) {
      const v = a.series[p]
      if (v === undefined || v === null) continue
      if (isIncome(a.meta)) inc += v
      else if (isOpex(a.meta)) exp += v
    }
    return { period: p, income: round(inc), opex: round(exp), noi: round(inc - exp) }
  })
  const withData = monthly.filter(m => m.income || m.opex)

  return {
    month: { actual: round(noi(cur)), budget: round(noiBudget(cur)) },
    ytd: { actual: round(noiYtd(cur)), budget: round(noiYtdBudget(cur)), opex_variance: round(opexYtdVar) },
    t12: { noi: round(sum(withData, m => m.noi)), income: round(sum(withData, m => m.income)), opex: round(sum(withData, m => m.opex)), months: withData.length },
    monthly,
  }
}

function monthVariances(cur) {
  const t = THRESHOLDS
  const lines = cur.filter(isOperating).map(l => {
    const variance = favorable(l)
    return { ...pick(l), variance: round(variance), has_note: Boolean(l.manager_note) }
  })
  const material = lines.filter(l => l.variance !== null && Math.abs(l.variance) >= t.mtdDollars &&
    (!l.budget || Math.abs(l.variance) / Math.abs(l.budget) >= t.mtdPct))
  material.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
  const notesOnSmall = lines.filter(l => l.has_note && Math.abs(l.variance || 0) < t.smallNote)
  return {
    material,
    unexplained: material.filter(l => !l.has_note).map(l => l.account_code),
    note_coverage: { material: material.length, explained: material.filter(l => l.has_note).length, notes_on_small_variances: notesOnSmall.length, notes_total: lines.filter(l => l.has_note).length },
  }
}

function ytdVariances(cur) {
  const t = THRESHOLDS
  const out = []
  for (const l of cur.filter(isOperating)) {
    const v = favorable(l, l.ytd_actual, l.ytd_budget)
    if (v === null) continue
    const big = Math.abs(v) >= t.ytdDollars && (!l.ytd_budget || Math.abs(v) / Math.abs(l.ytd_budget) >= t.ytdPct)
    if (!big) continue
    out.push({ account_code: l.account_code, account_name: l.account_name, section: l.section, group: l.account_group,
      ytd_actual: round(l.ytd_actual), ytd_budget: round(l.ytd_budget), variance: round(v),
      unbudgeted: !l.ytd_budget && Math.abs(l.ytd_actual || 0) >= t.unbudgetedYtd })
  }
  return out.sort((a, b) => a.variance - b.variance) // worst first
}

// Unbudgeted spending below NOI (consulting, legal) slips past NOI-based checks.
function belowTheLine(cur) {
  return cur.filter(l => l.account_group === 'Non-operating Expenses' && !/depreciation|amortization/i.test(`${l.section} ${l.account_name}`))
    .filter(l => !l.ytd_budget && Math.abs(l.ytd_actual || 0) >= THRESHOLDS.unbudgetedYtd)
    .map(l => ({ account_code: l.account_code, account_name: l.account_name, ytd_actual: round(l.ytd_actual), month_actual: round(l.actual) }))
}

function trends(accounts, months) {
  const t = THRESHOLDS
  const out = []
  for (const [code, a] of accounts) {
    if (!isOperating(a.meta)) continue
    const vals = months.map(p => a.series[p]).map(v => (v === undefined ? null : v))
    const have = vals.filter(v => v !== null)
    if (have.length < 6) continue
    const t12 = sum(have, v => Math.abs(v))
    if (t12 < t.trendMinT12) continue
    const recent = vals.slice(-3).filter(v => v !== null)
    const prior = vals.slice(0, -3).filter(v => v !== null)
    if (recent.length < 3 || !prior.length) continue
    const r = sum(recent, v => v) / recent.length
    const p = sum(prior, v => v) / prior.length
    if (!p || Math.abs(r - p) < t.trendDollarsPerMonth || Math.abs(r / p - 1) < t.trendPct) continue
    // A trend has to hold in at least 2 of the last 3 months, so one-off
    // spikes (e.g. the August student turn) don't read as trends.
    const up = r > p
    const moved = v => {
      const d = up ? v - p : p - v
      return d >= t.trendDollarsPerMonth && d >= Math.abs(p) * t.trendPct
    }
    const persistent = recent.filter(moved).length >= 2
    if (!persistent) continue
    const worse = isIncome(a.meta) ? r < p : r > p
    out.push({ account_code: code, account_name: a.meta.account_name, section: a.meta.section, group: a.meta.account_group,
      prior_avg: round(p), recent_avg: round(r), change_pct: Math.round((r / p - 1) * 100), direction: worse ? 'worse' : 'better',
      series: months.map((m, i) => ({ period: m, actual: round(vals[i]) })) })
  }
  return out.sort((a, b) => Math.abs(b.recent_avg - b.prior_avg) - Math.abs(a.recent_avg - a.prior_avg))
}

// Income and expense accounts for each billed-back utility. Covers both
// "Utility Income - Water/Sewer" (Entrata) and "Water/Sewer Rebill" (Yardi)
// naming. Common-area and vacant-unit costs aren't billed back, so they're
// left out of the expense side.
const BILLED = '(rebill|reimb|recover|billback)'
const UTILITIES = [
  { name: 'Electricity', income: new RegExp(`utility income.*electric|electric.*${BILLED}`, 'i'), expense: /unit electric/i },
  { name: 'Water/Sewer', income: new RegExp(`utility income.*(water|sewer)|(water|sewer).*${BILLED}`, 'i'), expense: /water|sewer/i, utilitySection: true },
  { name: 'Gas', income: new RegExp(`utility income.*gas|gas.*${BILLED}`, 'i'), expense: /unit (natural )?gas/i },
  { name: 'Trash', income: new RegExp(`utility income.*trash|trash.*${BILLED}`, 'i'), expense: /trash/i },
]
const NOT_BILLED = /common|vacant|model|clubhouse|office|irrigation/i
const isUtilityExpense = (u, meta) => isOpex(meta) && u.expense.test(meta.account_name) && !NOT_BILLED.test(meta.account_name) &&
  (!u.utilitySection || /utilit/i.test(`${meta.section} ${meta.account_name}`))

function utilityRecovery(accounts, months, cur) {
  const out = []
  for (const u of UTILITIES) {
    // Section + name, so RPM's "Water Income" under "Utility Income" matches.
    const inc = [...accounts.values()].filter(a => isIncome(a.meta) && u.income.test(`${a.meta.section || ''} ${a.meta.account_name}`))
    const exp = [...accounts.values()].filter(a => isUtilityExpense(u, a.meta))
    if (!exp.length || !inc.length) continue // nothing billed back for this utility
    const total = (list, p) => sum(list, a => a.series[p])
    const monthly = months.map(p => {
      const e = total(exp, p), i = total(inc, p)
      return { period: p, expense: round(e), billed: round(i), recovery_pct: e ? Math.round((i / e) * 100) : null }
    }).filter(m => m.expense)
    if (!monthly.length) continue
    const ratio = list => { const e = sum(list, m => m.expense); return e ? sum(list, m => m.billed) / e : null }
    const recent = monthly.slice(-2), prior = monthly.slice(0, -2)
    const t12Expense = sum(monthly, m => m.expense)
    const budgetIncome = sum(cur.filter(l => isIncome(l) && u.income.test(`${l.section || ''} ${l.account_name}`)), l => l.annual_budget)
    const budgetExpense = sum(cur.filter(l => isUtilityExpense(u, l)), l => l.annual_budget)
    const r12 = ratio(monthly), rRecent = ratio(recent), rPrior = prior.length ? ratio(prior) : null
    const shortfall = rPrior !== null && rRecent !== null ? round(sum(recent, m => m.expense) * rPrior - sum(recent, m => m.billed)) : null
    const budgetRatio = budgetExpense ? budgetIncome / budgetExpense : null
    const flag = t12Expense >= 20000 && (
      (r12 !== null && r12 < 0.25) ||                                              // barely billed at all
      (rPrior !== null && rRecent !== null && rRecent < rPrior * 0.6) ||            // recent drop
      (budgetRatio !== null && r12 !== null && r12 < budgetRatio * 0.75))           // well short of plan
    out.push({ utility: u.name, flag, t12_expense: round(t12Expense), t12_billed: round(sum(monthly, m => m.billed)),
      t12_recovery_pct: r12 === null ? null : Math.round(r12 * 100),
      recent_recovery_pct: rRecent === null ? null : Math.round(rRecent * 100),
      prior_recovery_pct: rPrior === null ? null : Math.round(rPrior * 100),
      recent_shortfall_vs_prior_rate: shortfall,
      budgeted_recovery_pct: budgetExpense ? Math.round((budgetIncome / budgetExpense) * 100) : null,
      monthly })
  }
  return out
}

function debtService(cur) {
  const interest = cur.filter(l => l.account_group === 'Non-operating Expenses' && /interest/i.test(l.account_name))
  return interest.map(l => {
    const ratio = l.actual ? (l.budget || 0) / l.actual : null
    return { account_code: l.account_code, account_name: l.account_name, actual: round(l.actual), budget: round(l.budget),
      ytd_actual: round(l.ytd_actual), ytd_budget: round(l.ytd_budget), annual_budget: round(l.annual_budget),
      budget_to_actual: ratio === null ? null : Math.round(ratio * 100) / 100,
      flag: ratio !== null && (ratio >= 1.15 || ratio <= 0.85) }
  })
}

function reserves(balance, cur) {
  const escrow = balance.filter(b => /(replacement|capital|renovation|capex).*(escrow|reserve)|(escrow|reserve).*(replacement|capital)|escrow\s*\/\s*reserve/i.test(b.account_name))
  const capex = cur.filter(l => l.account_group === 'Capital Improvements')
  const capexYtd = sum(capex, l => l.ytd_actual)
  const bal = sum(escrow, b => b.balance)
  return { replacement_reserve_balance: round(bal), capital_spend_ytd: round(capexYtd), capital_budget_ytd: round(sum(capex, l => l.ytd_budget)),
    flag: bal >= 25000 && capexYtd >= 25000,
    accounts: escrow.map(b => ({ account_code: b.account_code, account_name: b.account_name, balance: round(b.balance) })) }
}

function balanceSheetItems(balance) {
  const find = re => balance.filter(b => re.test(b.account_name)).map(b => ({ account_code: b.account_code, account_name: b.account_name, balance: round(b.balance) }))
  return {
    cash: find(/cash/i),
    receivables: find(/accounts receivable|other receivable/i),
    accrued: find(/accrued expenses|accrued vendor/i),
    prepaid_rent: find(/prepaid rent/i),
    security_deposits: find(/security deposits?$/i),
    debt: find(/loan|mortgage|note payable/i).filter(b => Math.abs(b.balance) > 1e6),
  }
}

function occupancy(beds) {
  const real = beds.filter(b => b.unit_type && !/catch all/i.test(b.unit_type))
  if (!real.length) return null
  const vacant = real.filter(b => (b.days_vacant || 0) > 0)
  const market = sum(real, b => b.market_rent), potential = sum(real, b => b.potential_rent)
  return { beds: real.length, vacant: vacant.length, occupancy_pct: Math.round((1 - vacant.length / real.length) * 1000) / 10,
    vacant_units: vacant.map(b => b.unit), market_rent_total: round(market), potential_rent_total: round(potential),
    gain_loss_to_lease_pct: market ? Math.round(((potential - market) / market) * 1000) / 10 : null }
}

function perBed(noi, cur, accounts, months, bedCount, basis = 'bed') {
  if (!bedCount) return null
  const sectionT12 = section => {
    let s = 0
    for (const a of accounts.values()) if (isOpex(a.meta) && a.meta.section === section) s += sum(months, p => a.series[p])
    return s
  }
  const sections = [...new Set(cur.filter(isOpex).map(l => l.section).filter(Boolean))]
  return {
    basis,          // 'bed' for student deals, 'unit' otherwise
    bed_count: bedCount,
    t12_noi: round(noi.t12.noi / bedCount),
    t12_income: round(noi.t12.income / bedCount),
    t12_opex: round(noi.t12.opex / bedCount),
    opex_ratio_pct: noi.t12.income ? Math.round((noi.t12.opex / noi.t12.income) * 100) : null,
    by_section: Object.fromEntries(sections.map(s => [s, round(sectionT12(s) / bedCount)])),
  }
}

function pick(l) {
  return { account_code: l.account_code, account_name: l.account_name, section: l.section, group: l.account_group,
    actual: round(l.actual), budget: round(l.budget), manager_note: l.manager_note || null }
}

// ---------------------------------------------------------------

// bedCount: beds for student deals. unitCount: units for conventional deals.
// Per-door metrics use beds when known, otherwise units.
export function runChecks({ period, bedCount = null, unitCount = null, gl, balance = [], beds = [] }) {
  const cur = gl.filter(r => r.period === period)
  if (!cur.length) throw new Error(`No GL data for ${period}`)
  const months = monthsBack(period, 12)
  const accounts = byAccount(gl.filter(r => months.includes(r.period)), period)

  const noi = noiSummary(cur, months, accounts)
  const variances = monthVariances(cur)
  const occ = occupancy(beds)
  return {
    period,
    thresholds: THRESHOLDS,
    noi,
    month_variances: variances.material,
    unexplained_variances: variances.unexplained,
    note_coverage: variances.note_coverage,
    ytd_variances: ytdVariances(cur),
    unbudgeted_below_noi: belowTheLine(cur),
    trends: trends(accounts, months),
    utility_recovery: utilityRecovery(accounts, months, cur),
    debt_service: debtService(cur),
    reserves: reserves(balance, cur),
    balance_sheet: balanceSheetItems(balance),
    occupancy: occ,
    per_bed: bedCount
      ? perBed(noi, cur, accounts, months, bedCount, 'bed')
      : perBed(noi, cur, accounts, months, unitCount || occ?.beds || null, 'unit'),
  }
}

// Accounts the review should show transaction detail for.
export function accountsToExplain(flags, limit = 12) {
  const codes = [
    ...flags.month_variances.filter(v => !v.has_note).map(v => v.account_code),
    ...flags.trends.filter(t => t.direction === 'worse').map(t => t.account_code),
    ...flags.ytd_variances.filter(v => v.variance < 0).map(v => v.account_code),
    ...flags.month_variances.map(v => v.account_code),
  ]
  return [...new Set(codes)].slice(0, limit)
}
