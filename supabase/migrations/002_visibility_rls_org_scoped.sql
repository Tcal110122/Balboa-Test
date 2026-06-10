-- ============================================================
-- Migration 002 — Scope visibility tables to org-level access
--
-- Links the properties table to deals, then replaces the broad
-- "any authenticated user can read" policies with org-scoped
-- policies that check deal_partners — same model used everywhere
-- else in the platform.
--
-- Run AFTER 001_visibility_schema.sql
-- ============================================================

-- ----------------------------------------------------------------
-- 1. Link properties → deals
-- ----------------------------------------------------------------

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id);

-- ----------------------------------------------------------------
-- 2. Drop the broad "authenticated read" policies from Migration 001
-- ----------------------------------------------------------------

DROP POLICY IF EXISTS "Authenticated read" ON properties;
DROP POLICY IF EXISTS "Authenticated read" ON property_data;
DROP POLICY IF EXISTS "Authenticated read" ON seo_snapshots;
DROP POLICY IF EXISTS "Authenticated read" ON keyword_rankings;
DROP POLICY IF EXISTS "Authenticated read" ON keyword_sets;

-- ----------------------------------------------------------------
-- 3. Replace with org-scoped policies
--
--    Logic: a user can read a row if their org has a deal_partners
--    entry for the deal linked to that property.
--    Balboa (sponsor) sees all deals.
--    50 East sees all deals (has a deal_partners row for every deal).
--    Twin Focus sees only their 5 deals.
-- ----------------------------------------------------------------

-- Helper: which property IDs is the current user allowed to see?
-- Used by every visibility table policy below.
CREATE OR REPLACE FUNCTION auth_visible_property_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT p.id
  FROM properties p
  JOIN deal_partners dp ON dp.deal_id = p.deal_id
  JOIN users u ON u.org_id = dp.org_id
  WHERE u.id = auth.uid()
$$;

-- properties
CREATE POLICY "Org scoped read" ON properties
  FOR SELECT TO authenticated
  USING (id IN (SELECT auth_visible_property_ids()));

-- property_data
CREATE POLICY "Org scoped read" ON property_data
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT auth_visible_property_ids()));

-- seo_snapshots
CREATE POLICY "Org scoped read" ON seo_snapshots
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT auth_visible_property_ids()));

-- keyword_rankings
CREATE POLICY "Org scoped read" ON keyword_rankings
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT auth_visible_property_ids()));

-- keyword_sets
CREATE POLICY "Org scoped read" ON keyword_sets
  FOR SELECT TO authenticated
  USING (property_id IN (SELECT auth_visible_property_ids()));

-- ----------------------------------------------------------------
-- 4. Update properties to point at their deals
--    Edit the deal names below to match exactly what's in your
--    deals table — then run this block.
-- ----------------------------------------------------------------

UPDATE properties SET deal_id = '2e0e81b4-d216-4fa4-895e-4045cbffdc1c' WHERE slug = 'darby-at-briarcliff';
UPDATE properties SET deal_id = '4e5358d5-a66e-423f-a7ea-6e9b16d8a2e6' WHERE slug = 'bootes-bozeman';
UPDATE properties SET deal_id = 'ff14bcc1-80a9-4b32-9370-799891894e18' WHERE slug = 'the-henry';
UPDATE properties SET deal_id = 'a5e7332c-68d6-40aa-80cb-d1d819b71c09' WHERE slug = 'ascend-rva';
UPDATE properties SET deal_id = '93d88397-51f3-4054-a037-ce0663cfa353' WHERE slug = '11th-and-spruce';
UPDATE properties SET deal_id = '02771f00-1501-4277-98a5-d8680766b834' WHERE slug = 'irvington-place';
UPDATE properties SET deal_id = 'a33eba23-5da8-4eb5-b8db-34614059633e' WHERE slug = 'pine25';
UPDATE properties SET deal_id = '0301cead-5fbe-40c5-b976-4459024a8ab8' WHERE slug = 'one-at-the-peninsula';
