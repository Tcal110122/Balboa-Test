/**
 * Supabase Edge Function: ingest-seo-snapshot
 *
 * For every property with a gsc_site_url, pulls Search Console data and writes:
 *   1. seo_snapshots   — one row per property/day (top-line totals + top_pages)   [unchanged contract]
 *   2. seo_page_rows   — one row per property/day/page  (clicks + ctr restored)
 *   3. seo_query_rows  — one row per property/day/query (branded-tagged)
 *
 * Change from prior version: pulls TRUE DAILY data (dimensions:["date"]) instead
 * of a 28-day rolling window stamped with a single date. The function now walks
 * each day in the lookback window and upserts one row per actual day, so the
 * 30-Day Trend reflects real day-over-day movement.
 *
 * Required Supabase secrets:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Deploy:  supabase functions deploy ingest-seo-snapshot
 * Invoke:  supabase functions invoke ingest-seo-snapshot
 * Backfill a range:  POST { "lookbackDays": 28 }   (default 3)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;

// GSC finalizes data with a lag; default to "yesterday" as the end date.
const DEFAULT_LOOKBACK_DAYS = 3;

interface GscRow {
  keys: string[];
  impressions: number;
  clicks: number;
  position: number;
  ctr: number;
}

async function getAccessToken(): Promise<string> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

function gscQuery(accessToken: string, siteUrl: string, body: object) {
  return fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((v ?? 0) * f) / f;
};

const stripDomain = (url: string, siteUrl: string) =>
  url.replace(siteUrl.replace(/\/$/, ""), "") || "/";

/**
 * Branded classifier. A query is "branded" if it contains the property's
 * domain second-level label OR a significant token from its display_name.
 * Tagged here at write time; not re-derived on read. A rebrand needs a backfill.
 */
function buildBrandedMatcher(displayName: string, siteUrl: string): (q: string) => boolean {
  const tokens = new Set<string>();

  // Domain SLD, e.g. https://irvingtonplace.com/ -> "irvingtonplace"
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./, "");
    const sld = host.split(".")[0];
    if (sld && sld.length >= 4) tokens.add(sld.toLowerCase());
  } catch { /* ignore malformed url */ }

  // Display-name words, dropping generic/stopword noise
  const STOP = new Set(["the", "at", "and", "of", "apartments", "apts", "residences", "place", "on"]);
  for (const w of displayName.toLowerCase().split(/\s+/)) {
    const clean = w.replace(/[^a-z0-9]/g, "");
    if (clean.length >= 4 && !STOP.has(clean)) tokens.add(clean);
  }

  // Also match the collapsed full name (e.g. "irvingtonplace")
  const collapsed = displayName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (collapsed.length >= 5) tokens.add(collapsed);

  const list = [...tokens];
  return (query: string) => {
    const q = query.toLowerCase().replace(/[^a-z0-9]/g, "");
    return list.some((t) => q.includes(t));
  };
}

interface DayData {
  date: string;
  impressions: number;
  clicks: number;
  avg_position: number;
  ctr: number;
  pages: GscRow[];
  queries: GscRow[];
}

async function fetchDay(accessToken: string, siteUrl: string, date: string): Promise<DayData> {
  // Totals for this single day
  const aggResp = await gscQuery(accessToken, siteUrl, { startDate: date, endDate: date, rowLimit: 1 });
  if (!aggResp.ok) throw new Error(`GSC aggregate failed ${siteUrl} ${date}: ${await aggResp.text()}`);
  const agg = (await aggResp.json()).rows?.[0] ?? {};

  // Per-page
  const pagesResp = await gscQuery(accessToken, siteUrl, {
    startDate: date, endDate: date,
    dimensions: ["page"],
    rowLimit: 100,
    orderBy: [{ fieldName: "impressions", sortOrder: "DESCENDING" }],
  });
  const pages: GscRow[] = pagesResp.ok ? ((await pagesResp.json()).rows ?? []) : [];

  // Per-query
  const queriesResp = await gscQuery(accessToken, siteUrl, {
    startDate: date, endDate: date,
    dimensions: ["query"],
    rowLimit: 250,
    orderBy: [{ fieldName: "impressions", sortOrder: "DESCENDING" }],
  });
  const queries: GscRow[] = queriesResp.ok ? ((await queriesResp.json()).rows ?? []) : [];

  return {
    date,
    impressions: agg.impressions ?? 0,
    clicks: agg.clicks ?? 0,
    avg_position: round(agg.position ?? 0, 2),
    ctr: round(agg.ctr ?? 0, 4),
    pages,
    queries,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Optional backfill: POST { "lookbackDays": N }
    let lookbackDays = DEFAULT_LOOKBACK_DAYS;
    try {
      const body = await req.json();
      if (body?.lookbackDays && Number.isFinite(body.lookbackDays)) {
        lookbackDays = Math.min(Math.max(1, body.lookbackDays), 90);
      }
    } catch { /* no body — use default */ }

    // GSC lag: end at "yesterday", walk back lookbackDays.
    const endDate = isoDaysAgo(1);
    const dates: string[] = [];
    for (let i = 0; i < lookbackDays; i++) dates.push(isoDaysAgo(1 + i));

    const { data: properties, error: propErr } = await supabase
      .from("properties")
      .select("id, slug, display_name, gsc_site_url")
      .not("gsc_site_url", "is", null)
      .eq("status", "active");
    if (propErr) throw propErr;
    if (!properties?.length) {
      return new Response(
        JSON.stringify({ ok: true, message: "No properties with gsc_site_url configured" }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
      );
    }

    const accessToken = await getAccessToken();
    const results: { property: string; status: string; days?: number; error?: string }[] = [];

    for (const property of properties) {
      try {
        const siteUrl = property.gsc_site_url!;
        const isBranded = buildBrandedMatcher(property.display_name, siteUrl);
        let daysWritten = 0;

        for (const date of dates) {
          const d = await fetchDay(accessToken, siteUrl, date);

          // --- top_pages JSONB now carries clicks + ctr (previously dropped) ---
          const topPages = d.pages.slice(0, 25).map((r) => ({
            page: stripDomain(r.keys[0], siteUrl),
            impressions: r.impressions,
            clicks: r.clicks,
            ctr: round(r.ctr, 4),
            position: round(r.position, 1),
          }));

          // 1) seo_snapshots — unchanged contract, now true daily
          const { error: snapErr } = await supabase.from("seo_snapshots").upsert({
            property_id: property.id,
            captured_at: d.date,
            impressions: d.impressions,
            clicks: d.clicks,
            avg_position: d.avg_position,
            ctr: d.ctr,
            top_pages: topPages,
          }, { onConflict: "property_id,captured_at" });
          if (snapErr) throw snapErr;

          // 2) seo_page_rows
          if (d.pages.length) {
            const pageRows = d.pages.map((r) => ({
              property_id: property.id,
              captured_at: d.date,
              page: stripDomain(r.keys[0], siteUrl),
              impressions: r.impressions,
              clicks: r.clicks,
              avg_position: round(r.position, 2),
              ctr: round(r.ctr, 4),
            }));
            const { error } = await supabase
              .from("seo_page_rows")
              .upsert(pageRows, { onConflict: "property_id,captured_at,page" });
            if (error) throw error;
          }

          // 3) seo_query_rows (branded-tagged)
          if (d.queries.length) {
            const queryRows = d.queries.map((r) => {
              const q = r.keys[0];
              return {
                property_id: property.id,
                captured_at: d.date,
                query: q,
                impressions: r.impressions,
                clicks: r.clicks,
                avg_position: round(r.position, 2),
                ctr: round(r.ctr, 4),
                is_branded: isBranded(q),
              };
            });
            const { error } = await supabase
              .from("seo_query_rows")
              .upsert(queryRows, { onConflict: "property_id,captured_at,query" });
            if (error) throw error;
          }

          daysWritten++;
        }

        results.push({ property: property.slug, status: "ok", days: daysWritten });
      } catch (err) {
        results.push({ property: property.slug, status: "error", error: String(err) });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, endDate, lookbackDays, results }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }
});
