-- ============================================================
-- Balboa REP — Visibility Tab Schema
-- Phase 1: SEO (Search Console + keyword rankings)
-- Run this in Supabase: Dashboard → SQL Editor → New query → Run
-- ============================================================

-- ----------------------------------------------------------------
-- PROPERTIES — master registry (shared across all platform tabs)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,
  display_name    TEXT NOT NULL,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL,
  address         TEXT,
  unit_count      INTEGER,
  product_type    TEXT,
  status          TEXT DEFAULT 'active',
  gsc_site_url    TEXT,         -- verified GSC property URL, e.g. 'https://irvingtonplace.com/'
  ads_customer_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- PROPERTY_DATA — ground-truth facts for AI accuracy checking
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_data (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID REFERENCES properties(id),
  effective_date      DATE NOT NULL,
  studio_asking_min   NUMERIC(8,2),
  studio_asking_max   NUMERIC(8,2),
  one_br_asking_min   NUMERIC(8,2),
  one_br_asking_max   NUMERIC(8,2),
  two_br_asking_min   NUMERIC(8,2),
  two_br_asking_max   NUMERIC(8,2),
  available_units     INTEGER,
  occupancy_pct       NUMERIC(5,2),
  school_district     TEXT,
  pet_policy          TEXT,
  parking_type        TEXT,
  amenities           JSONB,
  specials            TEXT,
  source              TEXT DEFAULT 'manual',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- SEO_SNAPSHOTS — daily Google Search Console pull
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  captured_at     DATE NOT NULL,
  impressions     INTEGER,
  clicks          INTEGER,
  avg_position    NUMERIC(5,2),
  ctr             NUMERIC(6,4),
  top_pages       JSONB,
  lcp_ms          INTEGER,
  fid_ms          INTEGER,
  cls_score       NUMERIC(5,3),
  mobile_score    INTEGER,
  desktop_score   INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (property_id, captured_at)
);

-- ----------------------------------------------------------------
-- KEYWORD_RANKINGS — DataForSEO rank tracking
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keyword_rankings (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id          UUID REFERENCES properties(id),
  captured_at          DATE NOT NULL,
  keyword              TEXT NOT NULL,
  search_engine        TEXT DEFAULT 'google',
  location_code        INTEGER,
  device               TEXT DEFAULT 'desktop',
  rank_position        INTEGER,
  rank_change          INTEGER,
  url_ranking          TEXT,
  search_volume        INTEGER,
  competition          NUMERIC(4,3),
  has_featured_snippet BOOLEAN DEFAULT FALSE,
  has_local_pack       BOOLEAN DEFAULT FALSE,
  has_ai_overview      BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (property_id, captured_at, keyword, search_engine, device)
);

-- ----------------------------------------------------------------
-- KEYWORD_SETS — seed keywords per property
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keyword_sets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id),
  keyword     TEXT NOT NULL,
  priority    TEXT DEFAULT 'primary',
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- VIEWS
-- ----------------------------------------------------------------

CREATE OR REPLACE VIEW v_seo_latest AS
SELECT DISTINCT ON (property_id) *
FROM seo_snapshots
ORDER BY property_id, captured_at DESC;

CREATE OR REPLACE VIEW v_keyword_trend_30d AS
SELECT
  property_id,
  keyword,
  search_engine,
  captured_at,
  rank_position,
  rank_change,
  AVG(rank_position) OVER (
    PARTITION BY property_id, keyword
    ORDER BY captured_at
    ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
  ) AS rank_7d_avg
FROM keyword_rankings
WHERE captured_at >= NOW() - INTERVAL '30 days';

-- ----------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ----------------------------------------------------------------

ALTER TABLE properties      ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_data   ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_sets    ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read all rows
CREATE POLICY "Authenticated read" ON properties      FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON property_data   FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON seo_snapshots   FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON keyword_rankings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read" ON keyword_sets    FOR SELECT TO authenticated USING (true);

-- Only service role (Edge Functions) can write
CREATE POLICY "Service role write" ON seo_snapshots    FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role write" ON keyword_rankings FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role write" ON properties       FOR ALL    TO service_role USING (true);
CREATE POLICY "Service role write" ON property_data    FOR ALL    TO service_role USING (true);
CREATE POLICY "Service role write" ON keyword_sets     FOR ALL    TO service_role USING (true);

-- ----------------------------------------------------------------
-- SAMPLE DATA — add your first property (edit to match your asset)
-- ----------------------------------------------------------------

INSERT INTO properties (slug, display_name, city, state, product_type, status, gsc_site_url) VALUES
  ('irvington-place',      'Irvington Place',         'Olivette',      'MO', 'multifamily', 'active', 'https://irvingtonplace.com/'),
  ('darby-at-briarcliff',  'Darby at Briarcliff',     'Kansas City',   'MO', 'multifamily', 'active', 'https://darbyatbriarcliff.com/'),
  ('11th-and-spruce',      '11th and Spruce',          'Philadelphia',  'PA', 'multifamily', 'active', 'https://11thandspruceapts.com/'),
  ('pine25',               'Pine25',                   'Charlotte',     'NC', 'multifamily', 'active', 'https://www.pine25northend.com/'),
  ('the-henry',            'The Henry',                'Charlotte',     'NC', 'multifamily', 'active', 'https://www.thehenryclt.com/'),
  ('one-at-the-peninsula', 'One at the Peninsula',     'Columbus',      'OH', 'multifamily', 'active', 'https://oneatthepeninsula.com/'),
  ('ascend-rva',           'Ascend RVA',               'Richmond',      'VA', 'multifamily', 'active', 'https://www.ascendrichmond.com/'),
  ('bootes-bozeman',       'Bootes Bozeman',           'Bozeman',       'MT', 'multifamily', 'active', 'http://bootesbozeman.com/')
ON CONFLICT (slug) DO NOTHING;
