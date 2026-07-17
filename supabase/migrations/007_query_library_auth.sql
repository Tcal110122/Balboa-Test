-- ============================================================
-- Migration 007 — Authenticated write access for Query Library
--
-- Allows any user logged in with a @thebalboagroup.com email
-- to insert, update, and delete rows in ai_probe_queries.
-- Read access remains open to anon (existing policy).
-- ============================================================

DROP POLICY IF EXISTS "Balboa write" ON ai_probe_queries;

CREATE POLICY "Balboa write" ON ai_probe_queries
  FOR ALL TO authenticated
  USING (
    (auth.jwt() ->> 'email') LIKE '%@thebalboagroup.com'
  )
  WITH CHECK (
    (auth.jwt() ->> 'email') LIKE '%@thebalboagroup.com'
  );
