-- ============================================================
-- Migration 003 — Dimensioned visibility data (page + query grain)
--
-- Adds per-page and per-query daily rows from Search Console so the
-- Visibility tab can compute:
--   - branded vs. non-branded segmentation
--   - CTR-vs-expected-by-position
--   - position distribution (pos 1-3 / 4-10 / 11-20 / 21+)
--   - per-page CTR (recovered from data already pulled)
--
-- Also hardens auth_visible_property_ids() with a pinned search_path
-- (Supabase linter flags SECURITY DEFINER without it).
--
-- Run AFTER 002_visibility_org_scope.sql
-- Safe to re-run (idempotent).
-- ============================================================

-- ----------------------------------------------------------------
-- 0. Harden the SECURITY DEFINER helper from Migration 002
--    Pinning search_path prevents object-shadowing privilege escalation.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_visible_property_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p.id
  FROM properties p
  JOIN deal_partners dp ON dp.deal_id = p.deal_id
  JOIN users u ON u.org_id = dp.org_id
  WHERE u.id = auth.uid()
$$;

-- ----------------------------------------------------------------
-- 1. SEO_PAGE_ROWS — one row per property / day / page
--    Replaces reliance on the seo_snapshots.top_pages JSONB blob.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_page_rows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID REFERENCES properties(id),
  captured_at  DATE NOT NULL,
  page         TEXT NOT NULL,
  impressions  INTEGER,
  clicks       INTEGER,
  avg_position NUMERIC(5,2),
  ctr          NUMERIC(6,4),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (property_id, captured_at, page)
);

CREATE INDEX IF NOT EXISTS idx_seo_page_rows_prop_date
  ON seo_page_rows (property_id, captured_at);

-- ----------------------------------------------------------------
-- 2. SEO_QUERY_ROWS — one row per property / day / query
--    Unlocks branded/non-branded + position distribution.
--    is_branded is tagged at WRITE time in the Edge Function
--    (service role bypasses RLS), so it is not re-derived on read.
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seo_query_rows (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID REFERENCES properties(id),
  captured_at  DATE NOT NULL,
  query        TEXT NOT NULL,
  impressions  INTEGER,
  clicks       INTEGER,
  avg_position NUMERIC(5,2),
  ctr          NUMERIC(6,4),
  is_branded   BOOLEAN,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (property_id, captured_at, query)
);

CREATE INDEX IF NOT EXISTS idx_seo_query_rows_prop_date
  ON seo_query_rows (property_id, captured_at);

CREATE INDEX IF NOT EXISTS idx_seo_query_rows_branded
  ON seo_query_rows (property_id, captured_at, is_branded);

-- ----------------------------------------------------------------
-- 3. ROW LEVEL SECURITY — same org-scoped model as every other
--    visibility table (keyed on property_id via the helper fn).
-- ----------------------------------------------------------------
ALTER TABLE seo_page_rows  ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_query_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org scoped read" ON seo_page_rows;
DROP POLICY IF EXISTS "Org scoped read" ON seo_query_rows;
DROP POLICY IF EXISTS "Service role write" ON seo_page_rows;
DROP POLICY IF EXISTS "Service role write" ON seo_query_rows;

CREATE POLICY "Org scoped read" ON seo_page_rows
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT auth_visible_property_ids()));

CREATE POLICY "Org scoped read" ON seo_query_rows
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT auth_visible_property_ids()));

CREATE POLICY "Service role write" ON seo_page_rows
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "Service role write" ON seo_query_rows
  FOR INSERT TO service_role WITH CHECK (true);

-- The platform uses the anon key (pre-auth phase), so anon also needs SELECT.
DROP POLICY IF EXISTS "Anon read" ON seo_page_rows;
DROP POLICY IF EXISTS "Anon read" ON seo_query_rows;
CREATE POLICY "Anon read" ON seo_page_rows  FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read" ON seo_query_rows FOR SELECT TO anon USING (true);

-- ----------------------------------------------------------------
-- 4. VIEWS — convenience rollups the UI can query directly
-- ----------------------------------------------------------------

-- Branded vs. non-branded daily totals
CREATE OR REPLACE VIEW v_seo_branded_split AS
SELECT
  property_id,
  captured_at,
  is_branded,
  SUM(impressions) AS impressions,
  SUM(clicks)      AS clicks,
  CASE WHEN SUM(impressions) > 0
       THEN ROUND(SUM(clicks)::numeric / SUM(impressions), 4)
       ELSE 0 END  AS ctr
FROM seo_query_rows
GROUP BY property_id, captured_at, is_branded;

-- Position distribution buckets per property / day
CREATE OR REPLACE VIEW v_seo_position_distribution AS
SELECT
  property_id,
  captured_at,
  COUNT(*) FILTER (WHERE avg_position <= 3)                          AS pos_1_3,
  COUNT(*) FILTER (WHERE avg_position > 3  AND avg_position <= 10)   AS pos_4_10,
  COUNT(*) FILTER (WHERE avg_position > 10 AND avg_position <= 20)   AS pos_11_20,
  COUNT(*) FILTER (WHERE avg_position > 20)                          AS pos_21_plus
FROM seo_query_rows
GROUP BY property_id, captured_at;
