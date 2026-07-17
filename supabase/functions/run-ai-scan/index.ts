// Supabase Edge Function: run-ai-scan
//
// For a given property (or all properties), fires probe queries at
// OpenAI (GPT-4o), Claude, and Gemini, records whether the property is
// mentioned, its rank in the response, and a response excerpt.
//
// Required Supabase secrets:
//   OPENAI_API_KEY
//   GEMINI_API_KEY
//
// Invoke manually:
//   POST { "property_slug": "irvington-place" }   — single property
//   POST {}                                         — all active properties
//
// Deploy: supabase functions deploy run-ai-scan

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ----------------------------------------------------------------
// Engine callers
// ----------------------------------------------------------------

async function queryOpenAI(prompt: string): Promise<string> {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI error: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices[0].message.content as string;
}

async function queryGemini(prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1000, temperature: 0.3 },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini error: ${await resp.text()}`);
  const data = await resp.json();
  return data.candidates[0].content.parts[0].text as string;
}

async function queryClaude(prompt: string): Promise<string> {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude error: ${await resp.text()}`);
  const data = await resp.json();
  return data.content[0].text as string;
}

// ----------------------------------------------------------------
// Mention detection
// ----------------------------------------------------------------

function detectMention(response: string, propertyName: string): {
  mentioned: boolean;
  rank: number | null;
  excerpt: string | null;
  mentionType: string | null;
} {
  const lower = response.toLowerCase();
  const nameVariants = buildNameVariants(propertyName);

  let firstIndex = Infinity;
  let matchedVariant = '';
  for (const variant of nameVariants) {
    const idx = lower.indexOf(variant.toLowerCase());
    if (idx !== -1 && idx < firstIndex) {
      firstIndex = idx;
      matchedVariant = variant;
    }
  }

  if (firstIndex === Infinity) {
    return { mentioned: false, rank: null, excerpt: null, mentionType: null };
  }

  // Estimate rank: count how many numbered list items appear before this mention
  const textBefore = response.slice(0, firstIndex);
  const listItemsBefore = (textBefore.match(/^\s*\d+[\.\)]/gm) || []).length;
  const rank = listItemsBefore + 1;

  // Determine mention type
  const mentionType = listItemsBefore === 0 ? 'featured' : 'listed';

  // Extract excerpt: sentence containing the mention
  const start = Math.max(0, firstIndex - 100);
  const end = Math.min(response.length, firstIndex + 200);
  const excerpt = response.slice(start, end).trim();

  return { mentioned: true, rank, excerpt, mentionType };
}

function buildNameVariants(name: string): string[] {
  const variants = [name];
  // Also try without common suffixes
  variants.push(name.replace(/\s+(apartments?|apts?|homes?|residences?|at\s+\w+)/gi, '').trim());
  // Lowercase variant already handled by toLowerCase in caller
  return [...new Set(variants.filter(v => v.length > 3))];
}

// ----------------------------------------------------------------
// Main handler
// ----------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const propertySlug: string | null = body.property_slug ?? null;
    const adHocQueryText: string | null = body.query_text ?? null;
    const adHocCategory: string = body.category ?? 'adhoc';
    const requestedEngines: string[] = body.engines ?? ['chatgpt', 'claude'];

    // ---- Ad-hoc single query mode ----
    if (adHocQueryText && propertySlug) {
      const { data: prop } = await supabase
        .from('properties')
        .select('id, slug, display_name')
        .eq('slug', propertySlug)
        .single();
      if (!prop) return json({ ok: false, error: 'Property not found' });

      const { data: scan } = await supabase
        .from('ai_scans')
        .insert({ property_id: prop.id, triggered_by: 'adhoc', status: 'running', engines_queried: requestedEngines })
        .select().single();

      const results = [];
      for (const engine of requestedEngines) {
        try {
          const response = engine === 'chatgpt'
            ? await queryOpenAI(adHocQueryText)
            : engine === 'claude'
            ? await queryClaude(adHocQueryText)
            : await queryGemini(adHocQueryText);
          const { mentioned, rank, excerpt, mentionType } = detectMention(response, prop.display_name);
          await supabase.from('ai_probe_results').insert({
            scan_id: scan.id, property_id: prop.id, engine,
            query_text: adHocQueryText, query_category: adHocCategory,
            property_mentioned: mentioned, mention_rank: rank,
            mention_type: mentionType, response_excerpt: excerpt, full_response: response,
          });
          results.push({ engine, mentioned, rank, excerpt, full_response: response });
        } catch (err) {
          results.push({ engine, error: String(err) });
        }
      }
      await supabase.from('ai_scans').update({ status: 'complete', completed_at: new Date().toISOString(), queries_run: results.length }).eq('id', scan.id);
      return json({ ok: true, mode: 'adhoc', property: prop.slug, query: adHocQueryText, results });
    }

    // ---- Batch scan mode ----
    let query = supabase
      .from('properties')
      .select('id, slug, display_name, city, state')
      .eq('status', 'active');
    if (propertySlug) query = query.eq('slug', propertySlug);

    const { data: properties, error: propErr } = await query;
    if (propErr) throw propErr;
    if (!properties?.length) return json({ ok: false, error: 'No matching properties found' });

    const engines = requestedEngines;
    const scanResults = [];

    for (const property of properties) {
      console.log(`Scanning ${property.display_name}…`);

      // Create scan record
      const { data: scan, error: scanErr } = await supabase
        .from('ai_scans')
        .insert({
          property_id: property.id,
          triggered_by: 'manual',
          status: 'running',
          engines_queried: engines,
        })
        .select()
        .single();
      if (scanErr) throw scanErr;

      // Load probe queries for this property
      const { data: queries } = await supabase
        .from('ai_probe_queries')
        .select('id, query_text, category')
        .eq('property_id', property.id)
        .eq('active', true);

      if (!queries?.length) {
        await supabase.from('ai_scans').update({ status: 'failed', completed_at: new Date().toISOString(), errors: { message: 'No active probe queries found' } }).eq('id', scan.id);
        continue;
      }

      const probeErrors: string[] = [];
      let queriesRun = 0;

      for (const q of queries) {
        for (const engine of engines) {
          try {
            let response: string;
            if (engine === 'chatgpt') {
              response = await queryOpenAI(q.query_text);
            } else if (engine === 'claude') {
              response = await queryClaude(q.query_text);
            } else {
              response = await queryGemini(q.query_text);
            }

            const { mentioned, rank, excerpt, mentionType } = detectMention(response, property.display_name);

            await supabase.from('ai_probe_results').insert({
              scan_id: scan.id,
              property_id: property.id,
              engine,
              query_text: q.query_text,
              query_category: q.category,
              property_mentioned: mentioned,
              mention_rank: rank,
              mention_type: mentionType,
              response_excerpt: excerpt,
              full_response: response,
            });

            queriesRun++;
            console.log(`  ${engine} / "${q.query_text.slice(0, 50)}…" → ${mentioned ? `mentioned (rank ${rank})` : 'not mentioned'}`);
          } catch (err) {
            probeErrors.push(`${engine}/${q.query_text.slice(0, 40)}: ${err}`);
            console.error(`  Error: ${err}`);
          }
        }
      }

      // Mark scan complete
      await supabase.from('ai_scans').update({
        status: 'complete',
        completed_at: new Date().toISOString(),
        queries_run: queriesRun,
        errors: probeErrors.length ? { errors: probeErrors } : null,
      }).eq('id', scan.id);

      scanResults.push({
        property: property.slug,
        scan_id: scan.id,
        queries_run: queriesRun,
        errors: probeErrors.length,
      });
    }

    return json({ ok: true, results: scanResults });
  } catch (err) {
    console.error('Fatal:', err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
