import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import supabase from '@/lib/supabase'
import { requireAuth } from '@/lib/auth'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Jina AI reader renders JavaScript-heavy pages and returns clean markdown
async function fetchPageText(url) {
  if (!url) return null
  try {
    const jinaUrl = 'https://r.jina.ai/' + url
    const resp = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',
      },
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const text = (await resp.text()).slice(0, 10000)
    return { text }
  } catch (err) {
    return { error: err.message?.includes('timeout') ? 'Timeout' : 'Fetch failed' }
  }
}

async function extractListing(pageText, platform, propertyName) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract apartment listing data from this ${platform} page for "${propertyName}".
Return ONLY valid JSON — no explanation, no markdown fences:
{
  "starting_rent": <number or null>,
  "max_rent": <number or null>,
  "floor_plans": [{"type": <string>, "rent_min": <number>, "rent_max": <number>}],
  "specials": <string or null — any concessions, free rent, move-in offers>,
  "available_units": <number or null>,
  "phone": <string or null>
}

If the page does not appear to be a rental listing, return {"not_a_listing": true}.

Page text:
${pageText}`,
      }],
    })
    const raw = msg.content[0].text.trim()
    const jsonStr = raw.match(/\{[\s\S]+\}/)?.[0]
    if (!jsonStr) return { parse_error: true }
    return JSON.parse(jsonStr)
  } catch {
    return { parse_error: true }
  }
}

function compareToWebsite(website, ils, platform) {
  const flags = []
  if (!website || website.error || website.not_a_listing) return flags

  if (website.starting_rent && ils.starting_rent) {
    const diff = ils.starting_rent - website.starting_rent
    const pct = Math.abs(diff) / website.starting_rent
    if (Math.abs(diff) > 75 || pct > 0.05) {
      const dir = diff < 0 ? 'lower' : 'higher'
      flags.push({
        type: diff < 0 ? 'price_low' : 'price_high',
        severity: pct > 0.1 ? 'high' : 'medium',
        msg: `Starting rent $${Math.abs(Math.round(diff))} ${dir} than website (${Math.round(pct * 100)}%)`,
      })
    }
  } else if (website.starting_rent && !ils.starting_rent) {
    flags.push({ type: 'no_price', severity: 'medium', msg: 'No rent found on ' + platform })
  }

  if (website.specials && !ils.specials) {
    flags.push({
      type: 'missing_special',
      severity: 'high',
      msg: 'Website advertises a special but none found on ' + platform,
    })
  }

  return flags
}

export async function POST(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { property_id } = await request.json()
    if (!property_id) return NextResponse.json({ error: 'property_id required' }, { status: 400 })

    const { data: prop, error: propErr } = await supabase
      .from('properties')
      .select('id, display_name, gsc_site_url, ils_urls')
      .eq('id', property_id)
      .maybeSingle()

    if (propErr || !prop) return NextResponse.json({ error: 'Property not found' }, { status: 404 })

    const urls = {
      website:        prop.ils_urls?.website || prop.gsc_site_url || null,
      apartments_com: prop.ils_urls?.apartments_com || null,
      zillow:         prop.ils_urls?.zillow || null,
      apartment_list: prop.ils_urls?.apartment_list || null,
    }

    const platforms = ['website', 'apartments_com', 'zillow', 'apartment_list']
    const labels = { website: 'Website', apartments_com: 'Apartments.com', zillow: 'Zillow', apartment_list: 'Apartment List' }

    // Fetch all pages in parallel
    const fetched = await Promise.all(
      platforms.map(p => urls[p] ? fetchPageText(urls[p]) : Promise.resolve(null))
    )

    // Extract listing data from each
    const extracted = await Promise.all(
      platforms.map((p, i) => {
        const f = fetched[i]
        if (!f) return Promise.resolve({ skipped: true })
        if (f.error) return Promise.resolve({ error: f.error })
        return extractListing(f.text, labels[p], prop.display_name)
      })
    )

    const results = {}
    const websiteData = extracted[0]
    platforms.forEach((p, i) => {
      const data = extracted[i]
      results[p] = {
        url: urls[p],
        label: labels[p],
        ...data,
        flags: i === 0 ? [] : compareToWebsite(websiteData, data, labels[p]),
      }
    })

    return NextResponse.json({ property: prop.display_name, results })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function PATCH(request) {
  const auth = await requireAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { property_id, ils_urls } = await request.json()
    if (!property_id) return NextResponse.json({ error: 'property_id required' }, { status: 400 })

    const { error } = await supabase
      .from('properties')
      .update({ ils_urls, updated_at: new Date().toISOString() })
      .eq('id', property_id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
