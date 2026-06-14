import { NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;

const PROPERTY_SLUGS = [
  'irvington-place',
  'darby-at-briarcliff',
  '11th-and-spruce',
  'pine25',
  'the-henry',
  'one-at-the-peninsula',
  'ascend-rva',
  'bootes-bozeman',
];

export async function GET(request: Request) {
  // Verify this is being called by Vercel's cron scheduler
  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scanUrl = `${SUPABASE_URL}/functions/v1/run-ai-scan`;
  const results = [];

  for (const slug of PROPERTY_SLUGS) {
    try {
      const resp = await fetch(scanUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ property_slug: slug }),
      });
      const data = await resp.json();
      results.push({ slug, ok: data.ok, queries_run: data.results?.[0]?.queries_run ?? 0 });
    } catch (err) {
      results.push({ slug, ok: false, error: String(err) });
    }
  }

  return NextResponse.json({ ok: true, scanned_at: new Date().toISOString(), results });
}
