// supabase/functions/ingest-ppc-snapshot/index.ts
//
// Phase 3 PPC ingestion. Mirrors the ingest-seo-snapshot pattern.
// Pulls Google Ads data via REST + GAQL (no official Deno client exists) and
// writes GRANULAR rows into the Migration 004 tables.
//
// Runtime: Supabase Edge Function (Deno). Writes with the service-role key,
// so RLS service_write policies apply.
//
// Env vars required (set via `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN          (offline refresh token from your OAuth consent)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID      (your MCC id, digits only, no dashes)
//
// Invoke with a JSON body: { "customer_id": "1234567890", "days": 28, "org_id": "...", "property_id": "..." }
// For backfill, call repeatedly with a wider `days` or a date range.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADS_API_VERSION = "v18"; // <-- the ONE place the API version lives. Bump here only.
const ADS_ENDPOINT = (customerId: string) =>
  `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`;

// ---------------------------------------------------------------------------
// OAuth: exchange the long-lived refresh token for a short-lived access token.
// ---------------------------------------------------------------------------
async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_ADS_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.access_token as string;
}

// ---------------------------------------------------------------------------
// Thin adapter over the Ads API. searchStream returns an array of batches,
// each with a `results` array. We flatten. This is the ONLY function that
// knows the wire format — keep it that way so a version bump is localized.
// ---------------------------------------------------------------------------
async function gaql(
  customerId: string,
  accessToken: string,
  query: string,
): Promise<any[]> {
  const res = await fetch(ADS_ENDPOINT(customerId), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN")!,
      "login-customer-id": Deno.env.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID")!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GAQL failed (${res.status}): ${await res.text()}`);
  const batches = await res.json(); // searchStream => array of { results: [...] }
  const rows: any[] = [];
  for (const b of batches) {
    if (Array.isArray(b.results)) rows.push(...b.results);
  }
  return rows;
}

// micros helper: Ads returns money as micros (1,000,000 = 1 unit of currency).
const toInt = (v: unknown) => (v == null ? 0 : Number(v));

// Branded classifier — reuse the SAME logic as the GSC pipeline.
// Pass in the property's brand tokens (SLD + display-name tokens) from caller.
function isBranded(term: string, brandTokens: string[]): boolean {
  const t = term.toLowerCase();
  return brandTokens.some((tok) => tok.length > 2 && t.includes(tok));
}

Deno.serve(async (req) => {
  try {
    const { customer_id, days = 28, org_id, property_id, brand_tokens = [] } = await req.json();
    if (!customer_id || !org_id) {
      return new Response(JSON.stringify({ error: "customer_id and org_id required" }), { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const accessToken = await getAccessToken();

    // GAQL uses a relative date range. DURING LAST_N_DAYS gives true daily rows
    // when combined with segments.date — same fix as the GSC daily-row correction.
    const during = `segments.date DURING LAST_${days}_DAYS`;

    // ---- 1. Account row (upsert) ----------------------------------------
    const acctRows = await gaql(customer_id, accessToken, `
      SELECT customer.id, customer.descriptive_name, customer.currency_code,
             customer.time_zone, customer.test_account
      FROM customer LIMIT 1`);
    const cust = acctRows[0]?.customer ?? {};
    const { data: acct, error: acctErr } = await supabase
      .from("ppc_accounts")
      .upsert({
        org_id, property_id: property_id ?? null,
        google_customer_id: customer_id,
        descriptive_name: cust.descriptiveName ?? null,
        currency_code: cust.currencyCode ?? "USD",
        time_zone: cust.timeZone ?? null,
        is_test_account: !!cust.testAccount,
      }, { onConflict: "org_id,google_customer_id" })
      .select("id").single();
    if (acctErr) throw acctErr;
    const accountId = acct.id;

    // ---- 2. Campaign structure (upsert) ---------------------------------
    const campRows = await gaql(customer_id, accessToken, `
      SELECT campaign.id, campaign.name, campaign.status,
             campaign.advertising_channel_type,
             campaign.bidding_strategy_type,
             campaign.target_cpa.target_cpa_micros,
             campaign_budget.amount_micros
      FROM campaign
      WHERE campaign.status != 'REMOVED'`);

    const campIdMap = new Map<string, string>(); // google_campaign_id -> our uuid
    for (const r of campRows) {
      const c = r.campaign ?? {};
      const { data: row, error } = await supabase
        .from("ppc_campaigns")
        .upsert({
          org_id, account_id: accountId,
          google_campaign_id: String(c.id),
          name: c.name ?? null,
          status: c.status ?? null,
          channel_type: c.advertisingChannelType ?? null,
          bidding_strategy_type: c.biddingStrategyType ?? null,
          target_cpa_micros: toInt(c.targetCpa?.targetCpaMicros) || null,
          daily_budget_micros: toInt(r.campaignBudget?.amountMicros) || null,
          managed_state: "synced",
          updated_at: new Date().toISOString(),
        }, { onConflict: "account_id,google_campaign_id" })
        .select("id").single();
      if (error) throw error;
      campIdMap.set(String(c.id), row.id);
    }

    // ---- 3. Campaign daily metrics + impression share -------------------
    const cmRows = await gaql(customer_id, accessToken, `
      SELECT campaign.id, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros,
             metrics.conversions, metrics.conversions_value,
             metrics.search_impression_share,
             metrics.search_budget_lost_impression_share,
             metrics.search_rank_lost_impression_share
      FROM campaign WHERE ${during}`);
    const cmPayload = cmRows.map((r) => ({
      org_id,
      campaign_id: campIdMap.get(String(r.campaign.id)),
      metric_date: r.segments.date,
      impressions: toInt(r.metrics?.impressions),
      clicks: toInt(r.metrics?.clicks),
      cost_micros: toInt(r.metrics?.costMicros),
      conversions: Number(r.metrics?.conversions ?? 0),
      conversions_value: Number(r.metrics?.conversionsValue ?? 0),
      search_impression_share: r.metrics?.searchImpressionShare ?? null,
      search_budget_lost_impression_share: r.metrics?.searchBudgetLostImpressionShare ?? null,
      search_rank_lost_impression_share: r.metrics?.searchRankLostImpressionShare ?? null,
    })).filter((x) => x.campaign_id);
    if (cmPayload.length) {
      const { error } = await supabase.from("ppc_campaign_metrics")
        .upsert(cmPayload, { onConflict: "campaign_id,metric_date" });
      if (error) throw error;
    }

    // ---- 4. Keyword daily metrics ---------------------------------------
    const kwRows = await gaql(customer_id, accessToken, `
      SELECT campaign.id, ad_group_criterion.criterion_id,
             ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             ad_group_criterion.quality_info.quality_score,
             segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM keyword_view WHERE ${during}`);
    const kwPayload = kwRows.map((r) => ({
      org_id,
      campaign_id: campIdMap.get(String(r.campaign.id)),
      google_criterion_id: String(r.adGroupCriterion?.criterionId),
      keyword_text: r.adGroupCriterion?.keyword?.text ?? null,
      match_type: r.adGroupCriterion?.keyword?.matchType ?? null,
      metric_date: r.segments.date,
      impressions: toInt(r.metrics?.impressions),
      clicks: toInt(r.metrics?.clicks),
      cost_micros: toInt(r.metrics?.costMicros),
      conversions: Number(r.metrics?.conversions ?? 0),
      quality_score: r.adGroupCriterion?.qualityInfo?.qualityScore ?? null,
    })).filter((x) => x.campaign_id);
    if (kwPayload.length) {
      const { error } = await supabase.from("ppc_keyword_metrics")
        .upsert(kwPayload, { onConflict: "campaign_id,google_criterion_id,metric_date" });
      if (error) throw error;
    }

    // ---- 5. Search terms (the waste goldmine) ---------------------------
    const stRows = await gaql(customer_id, accessToken, `
      SELECT campaign.id, search_term_view.search_term,
             segments.keyword.info.text, segments.keyword.info.match_type,
             segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM search_term_view WHERE ${during}`);
    const stPayload = stRows.map((r) => {
      const term = r.searchTermView?.searchTerm ?? "";
      return {
        org_id,
        campaign_id: campIdMap.get(String(r.campaign.id)),
        search_term: term,
        matched_keyword: r.segments?.keyword?.info?.text ?? null,
        match_type: r.segments?.keyword?.info?.matchType ?? null,
        metric_date: r.segments.date,
        impressions: toInt(r.metrics?.impressions),
        clicks: toInt(r.metrics?.clicks),
        cost_micros: toInt(r.metrics?.costMicros),
        conversions: Number(r.metrics?.conversions ?? 0),
        is_branded: isBranded(term, brand_tokens),
      };
    }).filter((x) => x.campaign_id && x.search_term);
    if (stPayload.length) {
      const { error } = await supabase.from("ppc_search_terms")
        .upsert(stPayload, { onConflict: "campaign_id,search_term,metric_date" });
      if (error) throw error;
    }

    // ---- 6. Geo metrics --------------------------------------------------
    // user_location_view = where the user actually was (better for radius
    // decisions than geographic_view, which includes "interested in").
    const geoRows = await gaql(customer_id, accessToken, `
      SELECT campaign.id, user_location_view.country_criterion_id,
             segments.geo_target_region, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM user_location_view WHERE ${during}`);
    const geoPayload = geoRows.map((r) => ({
      org_id,
      campaign_id: campIdMap.get(String(r.campaign.id)),
      geo_target_id: r.segments?.geoTargetRegion ?? String(r.userLocationView?.countryCriterionId ?? ""),
      location_name: r.segments?.geoTargetRegion ?? null, // resolve to name in a later pass if desired
      metric_date: r.segments.date,
      impressions: toInt(r.metrics?.impressions),
      clicks: toInt(r.metrics?.clicks),
      cost_micros: toInt(r.metrics?.costMicros),
      conversions: Number(r.metrics?.conversions ?? 0),
    })).filter((x) => x.campaign_id && x.geo_target_id);
    if (geoPayload.length) {
      const { error } = await supabase.from("ppc_geo_metrics")
        .upsert(geoPayload, { onConflict: "campaign_id,geo_target_id,metric_date" });
      if (error) throw error;
    }

    return new Response(JSON.stringify({
      ok: true,
      account_id: accountId,
      campaigns: campIdMap.size,
      campaign_metric_rows: cmPayload.length,
      keyword_rows: kwPayload.length,
      search_term_rows: stPayload.length,
      geo_rows: geoPayload.length,
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("ingest-ppc-snapshot error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
