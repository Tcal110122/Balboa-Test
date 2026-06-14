-- ============================================================
-- Migration 005 — Document storage
-- Stores uploaded files (rent rolls, T-12s, budgets, comp sets)
-- and their parsed data so history accumulates over time.
-- ============================================================

-- ----------------------------------------------------------------
-- 1. Storage bucket for raw files
-- ----------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Allow anon users to upload and read files in this bucket
CREATE POLICY "Anon upload documents"
  ON storage.objects FOR INSERT TO anon
  WITH CHECK (bucket_id = 'documents');

CREATE POLICY "Anon read documents"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'documents');

-- ----------------------------------------------------------------
-- 2. documents table — one row per uploaded file
-- ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID REFERENCES properties(id),
  doc_type        TEXT NOT NULL,    -- rent_roll | t12 | budget | comp_set
  filename        TEXT NOT NULL,
  storage_path    TEXT,             -- path in Supabase Storage bucket
  period_date     DATE,             -- as-of or period-end date from the document
  source_system   TEXT,             -- yardi | onesite | entrata | hellodata | rpm | apartmentiq | generic
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  parse_summary   JSONB,            -- key headline metrics (units, occ%, NOI, etc.)
  parsed_data     JSONB             -- full parsed output for future tooling
);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon read" ON documents FOR SELECT TO anon USING (true);
CREATE POLICY "Anon insert" ON documents FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Service write" ON documents FOR ALL TO service_role USING (true);

-- Index for common queries
CREATE INDEX IF NOT EXISTS documents_property_id_idx ON documents (property_id);
CREATE INDEX IF NOT EXISTS documents_doc_type_idx ON documents (doc_type);
CREATE INDEX IF NOT EXISTS documents_period_date_idx ON documents (period_date DESC);

-- ----------------------------------------------------------------
-- 3. Convenience view — latest document per property per type
-- ----------------------------------------------------------------

CREATE OR REPLACE VIEW v_documents_latest AS
SELECT DISTINCT ON (property_id, doc_type)
  d.*,
  p.display_name AS property_name,
  p.slug AS property_slug
FROM documents d
JOIN properties p ON p.id = d.property_id
ORDER BY property_id, doc_type, period_date DESC NULLS LAST, uploaded_at DESC;
