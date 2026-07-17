-- ============================================================
-- Migration 008 — ILS Audit
-- Adds ils_urls JSONB to properties for storing listing URLs
-- per platform (website, apartments_com, zillow, apartment_list)
-- ============================================================

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS ils_urls JSONB;
