import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import supabase from '@/lib/supabase'
import { requireAuth } from '@/lib/auth'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function fetchPageText(url) {
  if (!url) return null
  try {
    const resp = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    })
    if (!resp.ok) return { error: `HTTP ${resp.status}` }
    const html = await resp.text()
    // Strip scripts, styles, then all tags
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 9000)
    return { text }
  } catch (err) {
    return { error: err.message?.includes('timeout') ? 'Timeout' : 'Fetch blocked' }
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
