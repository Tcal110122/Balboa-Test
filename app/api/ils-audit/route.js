import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import supabase from '@/lib/supabase'
import { requireAuth, userClient } from '@/lib/auth'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function fetchPageText(url, label) {
  if (!url) return { label, url: null, text: null, error: 'No URL provided' }
  try {
    const resp = await fetch('https://r.jina.ai/' + url, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '20' },
      signal: AbortSignal.timeout(25000),
    })
    if (!resp.ok) return { label, url, text: null, error: `HTTP ${resp.status}` }
    const text = (await resp.text()).slice(0, 12000)
    return { label, url, text, error: null }
  } catch (err) {
    return { label, url, text: null, error: err.message?.includes('timeout') ? 'Timeout' : 'Fetch failed' }
  }
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

    // Fetch all pages in parallel
    const pages = await Promise.all([
      fetchPageText(urls.website,        'Property Website'),
      fetchPageText(urls.apartments_com, 'Apartments.com'),
      fetchPageText(urls.zillow,         'Zillow'),
      fetchPageText(urls.apartment_list, 'Apartment List'),
    ])

    // Build context for Claude
    const pageBlocks = pages.map(p => {
      const header = `--- ${p.label}${p.url ? ' (' + p.url + ')' : ''} ---`
      if (!p.url) return `${header}\nNot configured — no URL provided.\n`
      if (p.error) return `${header}\nFetch failed: ${p.error}\n`
      return `${header}\n${p.text}\n`
    }).join('\n')

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are auditing ILS listing accuracy for the apartment property "${prop.display_name}".

The property website is the source of truth. Compare each ILS platform against it and identify any discrepancies that could hurt leasing performance.

${pageBlocks}

Generate a concise HTML audit report using ONLY inline styles. Do not include <html>, <head>, <body>, or <style> tags.

Structure:
1. A summary line (e.g. "<strong style='color:#15803d'>✓ No issues found</strong>" or "<strong style='color:#dc2626'>3 issues found</strong>")
2. A comparison table (font-size:12px; border-collapse:collapse; width:100%) with columns for each source and rows for: Starting Rent, Specials / Concessions, Available Units, Floor Plans, Phone. Use padding:6px 10px on cells, border-bottom:1px solid #e2e8f0. Show "—" for missing data.
3. If there are issues, an "Issues" section listing them clearly. Flag: rent differs by >$50 or >5%, website has a special but ILS doesn't, ILS rent is lower than website, phone number differs.

Keep it tight — this is a quick ops check, not a marketing doc.`,
      }],
    })

    return NextResponse.json({
      property: prop.display_name,
      report: msg.content[0].text,
    })
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

    const db = userClient(request)
    const { error } = await db
      .from('properties')
      .update({ ils_urls, updated_at: new Date().toISOString() })
      .eq('id', property_id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
