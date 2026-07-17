// supabase/functions/generate-ppc-recommendations/index.ts
//
// The optimization engine. Reads the granular PPC data, computes recommendations
// DETERMINISTICALLY, and writes them to ppc_recommendations as status='pending'
// for the human approval queue. NOTHING here pushes to Google.
//
// Division of labor (important):
//   * All numbers — savings, budget deltas, marginal CPA — are computed in TS.
//   * The LLM (Sonnet) ONLY writes the `rationale` prose summarizing those
//     numbers. It never computes a figure and never decides a recommendation.
//     This keeps real ad spend off anything a model could hallucinate.
//
// Invoke: { "org_id": "...", "property_id": "..."(optional), "window_days": 30 }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MICROS = 1_000_000;

// --- Tunable thresholds (move to a config table later) ---------------------
const WASTE_MIN_SPEND_MICROS = 25 * MICROS;   // ignore trivial waste (<$25)
const BUDGET_LOST_IS_TRIGGER = 0.20;          // >20% impressions lost to budget
const REALLOC_STEP = 0.10;                    // propose ±10% budget moves
const BRANDED_WASTE_NOTE = "branded term — confirm no competitor conquesting before adding negative";

type Rec = {
  org_id: string;
  property_id: string | null;
  campaign_id: string | null;
  rec_type: string;
  payload: Record<string, unknown>;
  est_monthly_savings_micros: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  _factsForLLM: string; // internal: deterministic facts the LLM will phrase
};

// ---------------------------------------------------------------------------
// LLM rationale writer. Takes deterministic facts, returns prose. If it fails,
// we fall back to the raw facts string — a recommendation is never blocked on
// the LLM being available.
// ---------------------------------------------------------------------------
async function writeRationale(facts: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: "You write a 1-2 sentence plain-English rationale for a PPC optimization recommendation. Use ONLY the numbers given. Do not invent figures, do not add recommendations, do not hedge. Output prose only.",
        messages: [{ role: "user", content: facts }],
      }),
    });
    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text).join(" ").trim();
    return text || facts;
  } catch {
    return facts; // never block a rec on LLM availability
  }
}

Deno.serve(async (req) => {
  try {
    const { org_id, property_id = null, window_days = 30 } = await req.json();
    if (!org_id) return new Response(JSON.stringify({ error: "org_id required" }), { status: 400 });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const recs: Rec[] = [];

    // =====================================================================
    // LEVER 2 — KEYWORD HYGIENE: zero-conversion paid spend -> negatives
    // =====================================================================
    let wasteQ = supabase.from("ppc_waste_search_terms")
      .select("*").eq("org_id", org_id)
      .gte("cost_micros", WASTE_MIN_SPEND_MICROS)
      .order("cost_micros", { ascending: false });
    if (property_id) wasteQ = wasteQ.eq("property_id", property_id);
    const { data: waste, error: wErr } = await wasteQ;
    if (wErr) throw wErr;

    for (const w of waste ?? []) {
      // Monthly savings estimate: scale the windowed waste to a 30-day month.
      const monthly = Math.round((w.cost_micros / window_days) * 30);
      recs.push({
        org_id, property_id: w.property_id, campaign_id: w.campaign_id,
        rec_type: "ADD_NEGATIVE",
        payload: { search_term: w.search_term, is_branded: w.is_branded, match_type_suggestion: "PHRASE" },
        est_monthly_savings_micros: monthly,
        // branded waste is lower-confidence: could be intentional brand defense
        confidence: w.is_branded ? "MEDIUM" : (w.clicks >= 5 ? "HIGH" : "MEDIUM"),
        _factsForLLM:
          `Search term "${w.search_term}" cost $${(w.cost_micros / MICROS).toFixed(2)} over ${window_days} days ` +
          `with ${w.clicks} clicks and 0 conversions. Estimated $${(monthly / MICROS).toFixed(2)}/mo if left running. ` +
          (w.is_branded ? BRANDED_WASTE_NOTE + ". " : "") +
          `Recommend adding as a negative keyword.`,
      });
    }

    // =====================================================================
    // LEVER 1 — ALLOCATION: equalize marginal CPA across campaigns
    // =====================================================================
    let cpaQ = supabase.from("ppc_campaign_cpa").select("*").eq("org_id", org_id);
    if (property_id) cpaQ = cpaQ.eq("property_id", property_id);
    const { data: cpaRows, error: cErr } = await cpaQ;
    if (cErr) throw cErr;

    // Only campaigns with conversions have a real CPA. Median is the benchmark.
    const withCpa = (cpaRows ?? []).filter((r) => r.cpa_micros != null && r.conversions > 0);
    if (withCpa.length >= 2) {
      const sorted = [...withCpa].sort((a, b) => a.cpa_micros - b.cpa_micros);
      const medianCpa = sorted[Math.floor(sorted.length / 2)].cpa_micros;

      for (const r of withCpa) {
        const budgetLost = Number(r.budget_lost_is ?? 0);

        // Efficient AND budget-constrained -> propose INCREASE.
        if (r.cpa_micros <= medianCpa && budgetLost >= BUDGET_LOST_IS_TRIGGER) {
          const cur = sorted.find((x) => x.campaign_id === r.campaign_id);
          recs.push({
            org_id, property_id: r.property_id, campaign_id: r.campaign_id,
            rec_type: "REALLOCATE_BUDGET",
            payload: { direction: "increase", pct: REALLOC_STEP },
            est_monthly_savings_micros: null, // growth play, not a savings play
            confidence: "MEDIUM",
            _factsForLLM:
              `Campaign "${r.name}" has marginal CPA $${(r.cpa_micros / MICROS).toFixed(2)} ` +
              `(at/below the portfolio median of $${(medianCpa / MICROS).toFixed(2)}) but is losing ` +
              `${(budgetLost * 100).toFixed(0)}% of impressions to budget. Recommend increasing daily budget ` +
              `${(REALLOC_STEP * 100).toFixed(0)}% to capture efficient volume.`,
          });
        }

        // Inefficient -> propose DECREASE / reallocation away.
        if (r.cpa_micros > medianCpa * 1.5) {
          recs.push({
            org_id, property_id: r.property_id, campaign_id: r.campaign_id,
            rec_type: "REALLOCATE_BUDGET",
            payload: { direction: "decrease", pct: REALLOC_STEP },
            est_monthly_savings_micros: null,
            confidence: "LOW", // could be a strategic lease-up campaign; needs eyes
            _factsForLLM:
              `Campaign "${r.name}" has marginal CPA $${(r.cpa_micros / MICROS).toFixed(2)}, more than 1.5x the ` +
              `portfolio median of $${(medianCpa / MICROS).toFixed(2)}. Consider shifting ` +
              `${(REALLOC_STEP * 100).toFixed(0)}% of its budget to more efficient campaigns — unless this is an ` +
              `intentional lease-up push where volume outweighs efficiency.`,
          });
        }
      }
    }

    // =====================================================================
    // Write recommendations (LLM phrases each rationale).
    // =====================================================================
    let written = 0;
    for (const r of recs) {
      const rationale = await writeRationale(r._factsForLLM);
      const { _factsForLLM, ...row } = r;
      const { error } = await supabase.from("ppc_recommendations").insert({
        ...row, rationale, status: "pending",
      });
      if (error) throw error;
      written++;
    }

    return new Response(JSON.stringify({
      ok: true,
      generated: written,
      by_type: recs.reduce((acc: Record<string, number>, r) => {
        acc[r.rec_type] = (acc[r.rec_type] ?? 0) + 1; return acc;
      }, {}),
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("generate-ppc-recommendations error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
