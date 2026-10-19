-- ============================================================
-- Migration 009 — Monthly manager packages
--
-- Stores the monthly financial packages property managers email
-- to reports@thebalboagroup.com, the data parsed out of them, and
-- the monthly asset-management review + action items built on it.
--
-- All writes happen server-side with the service role (mail
-- intake, parsers, review generation). Signed-in users can read
-- rows for the deals their org can see — same model as lib/auth.js:
-- sponsor orgs see every deal, partner orgs see their deal_partners.
-- ============================================================

-- ----------------------------------------------------------------
-- 0. Helper: deal IDs the current user may see
-- ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_visible_deal_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT d.id
  FROM deals d
  WHERE EXISTS (
    SELECT 1
    FROM profiles pr
    JOIN organizations o ON o.id = pr.org_id
    WHERE pr.id = auth.uid() AND o.type = 'sponsor'
  )
  UNION
  SELECT dp.deal_id
  FROM deal_partners dp
  JOIN profiles pr ON pr.org_id = dp.org_id
  WHERE pr.id = auth.uid()
$$;

-- ----------------------------------------------------------------
-- 1. Deal metadata used for matching and normalizing
-- ----------------------------------------------------------------

-- Beds matter for student deals (Ascend, Boötes): per-bed metrics
-- instead of per-unit.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS bed_count INTEGER;

-- Names a deal goes by in manager files and email subjects.
-- Matching is case-insensitive substring; the longest alias wins.
CREATE TABLE IF NOT EXISTS deal_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_aliases_alias_idx ON deal_aliases (lower(alias));

INSERT INTO deal_aliases (deal_id, alias) VALUES
  ('a5e7332c-68d6-40aa-80cb-d1d819b71c09', 'Ascend RVA'),
  ('a5e7332c-68d6-40aa-80cb-d1d819b71c09', 'Ascend Richmond'),
  ('a5e7332c-68d6-40aa-80cb-d1d819b71c09', '1600 West Broad'),
  ('4e5358d5-a66e-423f-a7ea-6e9b16d8a2e6', 'Bootes Bozeman'),
  ('4e5358d5-a66e-423f-a7ea-6e9b16d8a2e6', 'Boötes Bozeman'),
  ('2e0e81b4-d216-4fa4-895e-4045cbffdc1c', 'Darby at Briarcliff'),
  ('ff14bcc1-80a9-4b32-9370-799891894e18', 'The Henry'),
  ('93d88397-51f3-4054-a037-ce0663cfa353', '11th & Spruce'),
  ('93d88397-51f3-4054-a037-ce0663cfa353', '11th and Spruce'),
  ('93d88397-51f3-4054-a037-ce0663cfa353', '1014 Spruce'),
  ('02771f00-1501-4277-98a5-d8680766b834', 'Irvington Place'),
  ('a33eba23-5da8-4eb5-b8db-34614059633e', 'Pine 25'),
  ('a33eba23-5da8-4eb5-b8db-34614059633e', 'Pine25'),
  ('0301cead-5fbe-40c5-b976-4459024a8ab8', 'One at the Peninsula'),
  ('0301cead-5fbe-40c5-b976-4459024a8ab8', 'One Pen')
ON CONFLICT DO NOTHING;

UPDATE deals SET bed_count = 428 WHERE id = 'a5e7332c-68d6-40aa-80cb-d1d819b71c09' AND bed_count IS NULL;

-- ----------------------------------------------------------------
-- 2. Intake: emails and the packages they carry
-- ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inbound_messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_message_id     TEXT NOT NULL,
  internet_message_id  TEXT UNIQUE,
  from_address         TEXT,
  subject              TEXT,
  received_at          TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'received',
                       -- received | processed | rejected_sender | no_attachments | failed
  error                TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS packages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    UUID REFERENCES inbound_messages(id) ON DELETE SET NULL,
  deal_id       UUID REFERENCES deals(id),
  period        DATE,             -- first day of the reporting month
  format        TEXT,             -- coastal-ridge-entrata | unknown | ...
  content_hash  TEXT UNIQUE,      -- hash of the sorted file hashes; skips re-sent duplicates
  status        TEXT NOT NULL DEFAULT 'received',
                -- received | parsed | needs_attention | failed
  summary       JSONB,            -- headline numbers + parser warnings
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS packages_deal_period_idx ON packages (deal_id, period DESC);

CREATE TABLE IF NOT EXISTS package_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id    UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,    -- path inside the zip, or attachment name
  storage_path  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER,
  content_type  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS package_files_package_idx ON package_files (package_id);

-- ----------------------------------------------------------------
-- 3. Parsed data
-- ----------------------------------------------------------------

-- One row per deal, month and GL account. The month's budget-vs-actual
-- report fills actual/budget/notes; the T-12 fills actuals for the
-- prior 11 months without touching budgets or notes.
CREATE TABLE IF NOT EXISTS gl_monthly (
  deal_id        UUID NOT NULL REFERENCES deals(id),
  period         DATE NOT NULL,
  account_code   TEXT NOT NULL,
  account_name   TEXT,
  account_group  TEXT,            -- Income | Operating Expenses | Non-operating Expenses | Capital Improvements
  section        TEXT,            -- manager's subtotal heading, e.g. Repairs & Maintenance
  actual         NUMERIC(14,2),
  budget         NUMERIC(14,2),
  ytd_actual     NUMERIC(14,2),
  ytd_budget     NUMERIC(14,2),
  annual_budget  NUMERIC(14,2),
  manager_note   TEXT,
  package_id     UUID REFERENCES packages(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (deal_id, period, account_code)
);

CREATE TABLE IF NOT EXISTS gl_detail (
  id            BIGSERIAL PRIMARY KEY,
  deal_id       UUID NOT NULL REFERENCES deals(id),
  period        DATE NOT NULL,
  account_code  TEXT NOT NULL,
  txn_date      DATE,
  post_date     DATE,
  reference     TEXT,
  txn_type      TEXT,
  memo          TEXT,
  unit          TEXT,
  counterparty  TEXT,
  amount        NUMERIC(14,2),
  package_id    UUID REFERENCES packages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS gl_detail_lookup_idx ON gl_detail (deal_id, period, account_code);

CREATE TABLE IF NOT EXISTS balance_sheet (
  deal_id       UUID NOT NULL REFERENCES deals(id),
  period        DATE NOT NULL,
  account_code  TEXT NOT NULL,
  account_name  TEXT,
  balance       NUMERIC(16,2),
  package_id    UUID REFERENCES packages(id) ON DELETE SET NULL,
  PRIMARY KEY (deal_id, period, account_code)
);

CREATE TABLE IF NOT EXISTS bed_snapshots (
  deal_id         UUID NOT NULL REFERENCES deals(id),
  period          DATE NOT NULL,
  unit            TEXT NOT NULL,
  unit_type       TEXT,
  market_rent     NUMERIC(10,2),
  potential_rent  NUMERIC(10,2),
  days_vacant     INTEGER,
  vacancy_loss    NUMERIC(10,2),
  scheduled_rent  NUMERIC(10,2),
  package_id      UUID REFERENCES packages(id) ON DELETE SET NULL,
  PRIMARY KEY (deal_id, period, unit)
);

-- Manager GL account -> Balboa standard category, for cross-portfolio
-- comparisons. Filled once per manager.
CREATE TABLE IF NOT EXISTS account_map (
  manager          TEXT NOT NULL,   -- e.g. coastal-ridge
  account_code     TEXT NOT NULL,
  balboa_category  TEXT NOT NULL,
  PRIMARY KEY (manager, account_code)
);

-- ----------------------------------------------------------------
-- 4. Monthly review and action items
-- ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS am_reviews (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      UUID NOT NULL REFERENCES deals(id),
  period       DATE NOT NULL,
  package_id   UUID REFERENCES packages(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'draft',   -- draft | approved | sent
  flags        JSONB,                           -- deterministic check results
  content      JSONB,                           -- summary, findings, scorecard, metrics
  model        TEXT,
  approved_by  UUID,
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS am_reviews_deal_period_idx ON am_reviews (deal_id, period DESC);

CREATE TABLE IF NOT EXISTS action_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id            UUID NOT NULL REFERENCES deals(id),
  review_id          UUID REFERENCES am_reviews(id) ON DELETE SET NULL,
  opened_period      DATE NOT NULL,
  title              TEXT NOT NULL,
  ask                TEXT NOT NULL,
  at_stake           TEXT,
  owner              TEXT,            -- Balboa team member
  status             TEXT NOT NULL DEFAULT 'open',
                     -- open | sent | response_received | resolved
  manager_response   TEXT,
  due_date           DATE,
  resolved_period    DATE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS action_items_deal_status_idx ON action_items (deal_id, status);

-- ----------------------------------------------------------------
-- 5. Row level security
-- ----------------------------------------------------------------

ALTER TABLE deal_aliases     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_files    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_monthly       ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_detail        ENABLE ROW LEVEL SECURITY;
ALTER TABLE balance_sheet    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bed_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_map      ENABLE ROW LEVEL SECURITY;
ALTER TABLE am_reviews       ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_items     ENABLE ROW LEVEL SECURITY;

-- inbound_messages: no user policy — service role only (raw sender data).

CREATE POLICY "Org scoped read" ON deal_aliases  FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON packages      FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON package_files FOR SELECT TO authenticated
  USING (package_id IN (SELECT id FROM packages WHERE deal_id IN (SELECT auth_visible_deal_ids())));
CREATE POLICY "Org scoped read" ON gl_monthly    FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON gl_detail     FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON balance_sheet FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON bed_snapshots FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON am_reviews    FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Org scoped read" ON action_items  FOR SELECT TO authenticated USING (deal_id IN (SELECT auth_visible_deal_ids()));
CREATE POLICY "Authenticated read" ON account_map FOR SELECT TO authenticated USING (true);

-- ----------------------------------------------------------------
-- 6. Private bucket for the raw files (service role only)
-- ----------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('manager-packages', 'manager-packages', false)
ON CONFLICT (id) DO NOTHING;
