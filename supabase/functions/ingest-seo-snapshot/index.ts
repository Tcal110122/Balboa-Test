/**
 * Supabase Edge Function: ingest-seo-snapshot
 *
 * Pulls yesterday's Search Console data for every property that has
 * a gsc_site_url set, then upserts one row per property into seo_snapshots.
 *
 * Required Supabase secrets (set via: supabase secrets set KEY=value):
 *   GOOGLE_CLIENT_ID      — from your OAuth credentials JSON
 *   GOOGLE_CLIENT_SECRET  — from your OAuth credentials JSON
 *   GOOGLE_REFRESH_TOKEN  — obtained once via public/oauth-setup.html
 *
 * Deploy: supabase functions deploy ingest-seo-snapshot
 * Trigger manually: supabase functions invoke ingest-seo-snapshot
 * Schedule: set up in Supabase Dashboard → Edge Functions → Schedule
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_REFRESH_TOKEN = Deno.env.get("GOOGLE_REFRESH_TOKEN")!;

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
    const err = await resp.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

async function fetchGscData(
  accessToken: string,
  siteUrl: string,
  date: string,
): Promise<{
  impressions: number;
  clicks: number;
  avg_position: number;
  ctr: number;
  top_pages: object[];
}> {
  // Aggregate row (all pages combined)
  const aggregateResp = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: date,
        endDate: date,
        rowLimit: 1,
      }),
    },
  );
  if (!aggregateResp.ok) {
    const err = await aggregateResp.text();
    throw new Error(`GSC aggregate query failed for ${siteUrl}: ${err}`);
  }
  const aggregateData = await aggregateResp.json();
  const row = aggregateData.rows?.[0] ?? {};

  // Top pages breakdown
  const pagesResp = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: date,
        endDate: date,
        dimensions: ["page"],
        rowLimit: 25,
        orderBy: [{ fieldName: "impressions", sortOrder: "DESCENDING" }],
      }),
    },
  );
  const pagesData = pagesResp.ok ? await pagesResp.json() : { rows: [] };
  const topPages = (pagesData.rows ?? []).map((r: {
    keys: string[];
    impressions: number;
    clicks: number;
    position: number;
    ctr: number;
  }) => ({
    page: r.keys[0].replace(siteUrl.replace(/\/$/, ""), "") || "/",
    impressions: r.impressions,
    clicks: r.clicks,
    position: Math.round(r.position * 10) / 10,
  }));

  return {
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    avg_position: Math.round((row.position ?? 0) * 100) / 100,
    ctr: Math.round((row.ctr ?? 0) * 10000) / 10000,
    top_pages: topPages,
  };
}

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Yesterday's date in YYYY-MM-DD (GSC data lags ~1 day)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const date = yesterday.toISOString().split("T")[0];

    // Load all properties with a GSC site URL configured
    const { data: properties, error: propErr } = await supabase
      .from("properties")
      .select("id, slug, display_name, gsc_site_url")
      .not("gsc_site_url", "is", null)
      .eq("status", "active");

    if (propErr) throw propErr;
    if (!properties?.length) {
      return new Response(
        JSON.stringify({ ok: true, message: "No properties with gsc_site_url configured" }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const accessToken = await getAccessToken();
    const results: { property: string; status: string; error?: string }[] = [];

    for (const property of properties) {
      try {
        const gscData = await fetchGscData(accessToken, property.gsc_site_url!, date);

        const { error: upsertErr } = await supabase
          .from("seo_snapshots")
          .upsert({
            property_id: property.id,
            captured_at: date,
            ...gscData,
          }, { onConflict: "property_id,captured_at" });

        if (upsertErr) throw upsertErr;
        results.push({ property: property.slug, status: "ok" });
      } catch (err) {
        results.push({ property: property.slug, status: "error", error: String(err) });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, date, results }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
