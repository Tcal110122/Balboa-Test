-- ============================================================
-- Migration 006 — Underwriting deal file archival
-- Adds storage_path to underwriting_deals so uploaded T-12
-- files are archived to Supabase Storage alongside the
-- parsed data already saved in t12_data.
-- Note: documents.property_id is already nullable (no NOT NULL
-- in migration 005), so underwriting docs can be saved there
-- with property_id = NULL.
-- ============================================================

ALTER TABLE underwriting_deals
  ADD COLUMN IF NOT EXISTS storage_path TEXT;
