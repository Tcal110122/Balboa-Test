-- ============================================================
-- Migration 003 — Phase 2: AI Probe Engine tables
-- Run after 002_visibility_rls_org_scoped.sql
-- ============================================================

-- ----------------------------------------------------------------
-- 1. Core tables (from schema spec)
-- ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_scans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID REFERENCES properties(id),
  triggered_by        TEXT DEFAULT 'cron',
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  status              TEXT DEFAULT 'running',
  engines_queried     TEXT[],
  queries_run         INTEGER,
  errors              JSONB
);

CREATE TABLE IF NOT EXISTS ai_probe_results (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id             UUID REFERENCES ai_scans(id),
  property_id         UUID REFERENCES properties(id),
  captured_at         TIMESTAMPTZ DEFAULT NOW(),
  engine              TEXT NOT NULL,
  query_text          TEXT NOT NULL,
  query_category      TEXT,
  property_mentioned  BOOLEAN DEFAULT FALSE,
  mention_rank        INTEGER,
  mention_type        TEXT,
  response_excerpt    TEXT,
  full_response       TEXT,
  competitors_mentioned TEXT[],
  mention_confidence  NUMERIC(4,3)
);

CREATE TABLE IF NOT EXISTS ai_accuracy_flags (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_result_id     UUID REFERENCES ai_probe_results(id),
  property_id         UUID REFERENCES properties(id),
  flagged_at          TIMESTAMPTZ DEFAULT NOW(),
  field_name          TEXT NOT NULL,
  ai_reported_value   TEXT,
  actual_value        TEXT,
  severity            TEXT DEFAULT 'medium',
  status              TEXT DEFAULT 'open',
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT
);

CREATE TABLE IF NOT EXISTS ai_citation_sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id             UUID REFERENCES ai_scans(id),
  property_id         UUID REFERENCES properties(id),
  engine              TEXT NOT NULL,
  source_name         TEXT NOT NULL,
  source_url          TEXT,
  confidence          TEXT DEFAULT 'inferred',
  freshness           TEXT,
  captured_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_probe_queries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  query_text      TEXT NOT NULL,
  category        TEXT,
  active          BOOLEAN DEFAULT TRUE
);

-- ----------------------------------------------------------------
-- 2. RLS
-- ----------------------------------------------------------------

ALTER TABLE ai_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_probe_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_accuracy_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_citation_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_probe_queries ENABLE ROW LEVEL SECURITY;

-- Anon read (tighten to org-scoped when Supabase Auth added in Phase 4)
CREATE POLICY "Anon read" ON ai_scans FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read" ON ai_probe_results FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read" ON ai_accuracy_flags FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read" ON ai_citation_sources FOR SELECT TO anon USING (true);
CREATE POLICY "Anon read" ON ai_probe_queries FOR SELECT TO anon USING (true);

-- Service role can write
CREATE POLICY "Service write" ON ai_scans FOR ALL TO service_role USING (true);
CREATE POLICY "Service write" ON ai_probe_results FOR ALL TO service_role USING (true);
CREATE POLICY "Service write" ON ai_accuracy_flags FOR ALL TO service_role USING (true);
CREATE POLICY "Service write" ON ai_citation_sources FOR ALL TO service_role USING (true);
CREATE POLICY "Service write" ON ai_probe_queries FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------
-- 3. Views
-- ----------------------------------------------------------------

CREATE OR REPLACE VIEW v_ai_presence_latest AS
SELECT
  r.property_id,
  r.engine,
  COUNT(*) AS queries_run,
  SUM(CASE WHEN r.property_mentioned THEN 1 ELSE 0 END) AS mentions,
  ROUND(AVG(r.mention_rank) FILTER (WHERE r.property_mentioned), 1) AS avg_rank,
  MAX(s.completed_at) AS last_scanned
FROM ai_probe_results r
JOIN ai_scans s ON s.id = r.scan_id
WHERE s.id = (
  SELECT id FROM ai_scans
  WHERE property_id = r.property_id
  AND status = 'complete'
  ORDER BY completed_at DESC LIMIT 1
)
GROUP BY r.property_id, r.engine;

CREATE OR REPLACE VIEW v_accuracy_flags_open AS
SELECT
  f.*,
  p.display_name AS property_name,
  r.engine,
  r.query_text
FROM ai_accuracy_flags f
JOIN properties p ON p.id = f.property_id
JOIN ai_probe_results r ON r.id = f.probe_result_id
WHERE f.status = 'open'
ORDER BY f.severity DESC, f.flagged_at DESC;
