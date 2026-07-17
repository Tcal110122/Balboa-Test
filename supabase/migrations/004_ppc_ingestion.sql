-- Migration 004: PPC (Google Ads) ingestion layer
-- Phase 3 of the Visibility system. Follows conventions from 001–003:
--   * org-scoped RLS on every table
--   * service-role write policies (Edge Functions write; authed users read)
--   * search_path-hardened SECURITY DEFINER helper reused from 002
--   * true granular rows (NOT daily rollups) so the optimization engine
--     has search-term / geo / keyword detail to reason over.
--
-- Design principle carried over from the GSC fix: never store only the
-- aggregate. The intelligence (waste detection, marginal-CPA reallocation,
-- negative-keyword mining, geo tightening) lives in the granular dimensions.
-- A rollup table is derivable from these; the reverse is not.

-- ---------------------------------------------------------------------------
-- Reference: account / campaign structure mirror
-- We mirror Google's hierarchy so the control plane is the system of record.
-- These rows are written by ingestion AND by the control plane (proposed/
-- pushed changes), so they carry a `managed_state` to track sync.
-- ---------------------------------------------------------------------------

create table if not exists ppc_accounts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  property_id     uuid references properties(id) on delete set null,
  google_customer_id  text not null,          -- Ads API customer id (no dashes)
  descriptive_name    text,
  currency_code       text default 'USD',
  time_zone           text,
  is_test_account     boolean not null default false,  -- sandbox vs live
  created_at      timestamptz not null default now(),
  unique (org_id, google_customer_id)
);

create table if not exists ppc_campaigns (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  account_id      uuid not null references ppc_accounts(id) on delete cascade,
  google_campaign_id  text not null,
  name            text,
  status          text,                        -- ENABLED / PAUSED / REMOVED
  channel_type    text,                        -- SEARCH / PMAX / DISPLAY
  bidding_strategy_type text,                  -- TARGET_CPA / MAXIMIZE_CONVERSIONS ...
  target_cpa_micros     bigint,                -- null unless tCPA
  daily_budget_micros   bigint,
  -- control-plane fields:
  managed_state   text not null default 'synced',  -- synced / pending_push / push_failed
  desired_daily_budget_micros bigint,          -- what our engine wants it to be
  updated_at      timestamptz not null default now(),
  unique (account_id, google_campaign_id)
);

-- ---------------------------------------------------------------------------
-- Daily metric rows (granular, per entity per day)
-- ---------------------------------------------------------------------------

create table if not exists ppc_campaign_metrics (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  campaign_id     uuid not null references ppc_campaigns(id) on delete cascade,
  metric_date     date not null,
  impressions     bigint default 0,
  clicks          bigint default 0,
  cost_micros     bigint default 0,
  conversions     numeric(12,2) default 0,     -- can be fractional (Ads attributes)
  conversions_value numeric(14,2) default 0,
  -- the diagnostic metrics that drive waste detection:
  search_impression_share              numeric(6,4),  -- 0..1
  search_budget_lost_impression_share  numeric(6,4),  -- budget-constrained signal
  search_rank_lost_impression_share    numeric(6,4),  -- quality/bid signal
  unique (campaign_id, metric_date)
);

create table if not exists ppc_keyword_metrics (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  campaign_id     uuid not null references ppc_campaigns(id) on delete cascade,
  google_criterion_id text not null,
  keyword_text    text,
  match_type      text,                        -- EXACT / PHRASE / BROAD
  metric_date     date not null,
  impressions     bigint default 0,
  clicks          bigint default 0,
  cost_micros     bigint default 0,
  conversions     numeric(12,2) default 0,
  quality_score   int,
  unique (campaign_id, google_criterion_id, metric_date)
);

-- The waste goldmine: every actual query that triggered a paid click.
create table if not exists ppc_search_terms (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  campaign_id     uuid not null references ppc_campaigns(id) on delete cascade,
  search_term     text not null,
  matched_keyword text,
  match_type      text,
  metric_date     date not null,
  impressions     bigint default 0,
  clicks          bigint default 0,
  cost_micros     bigint default 0,
  conversions     numeric(12,2) default 0,
  -- classification written at ingest, same pattern as GSC branded tagging:
  is_branded      boolean,                     -- matches property/brand SLD tokens
  added_as_negative boolean not null default false,
  unique (campaign_id, search_term, metric_date)
);

-- Geo performance: where leases/clicks actually originate, for radius tightening.
create table if not exists ppc_geo_metrics (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  campaign_id     uuid not null references ppc_campaigns(id) on delete cascade,
  geo_target_id   text,                        -- Ads geo constant id
  location_name   text,                        -- resolved name (city/zip/metro)
  metric_date     date not null,
  impressions     bigint default 0,
  clicks          bigint default 0,
  cost_micros     bigint default 0,
  conversions     numeric(12,2) default 0,
  unique (campaign_id, geo_target_id, metric_date)
);

-- ---------------------------------------------------------------------------
-- Optimization engine output: proposed changes awaiting human approval.
-- This is the human-in-the-loop queue. Nothing pushes to Google without an
-- approved row here in Phase 1 of operation.
-- ---------------------------------------------------------------------------

create table if not exists ppc_recommendations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  property_id     uuid references properties(id) on delete set null,
  campaign_id     uuid references ppc_campaigns(id) on delete set null,
  rec_type        text not null,   -- ADD_NEGATIVE / REALLOCATE_BUDGET / ADJUST_TCPA / TIGHTEN_GEO / PAUSE_KEYWORD
  rationale       text,            -- human-readable; LLM-synthesized summary ok
  payload         jsonb not null,  -- structured params for the API push
  est_monthly_savings_micros bigint,  -- quantified where computable
  confidence      text,            -- HIGH / MEDIUM / LOW
  status          text not null default 'pending',  -- pending / approved / rejected / pushed / push_failed
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references users(id) on delete set null,
  pushed_at       timestamptz
);

-- ---------------------------------------------------------------------------
-- RLS — identical pattern to migrations 002/003
-- ---------------------------------------------------------------------------

-- user_in_org: required by the RLS loop below. Returns true if the current
-- authenticated user belongs to the given org_id.
create or replace function user_in_org(check_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from users u where u.id = auth.uid() and u.org_id = check_org_id
  );
$$;

alter table ppc_accounts            enable row level security;
alter table ppc_campaigns           enable row level security;
alter table ppc_campaign_metrics    enable row level security;
alter table ppc_keyword_metrics     enable row level security;
alter table ppc_search_terms        enable row level security;
alter table ppc_geo_metrics         enable row level security;
alter table ppc_recommendations     enable row level security;

-- Reuse the org-membership helper from migration 002.
-- (Assumes public.user_in_org(uuid) SECURITY DEFINER with hardened search_path.)

do $$
declare t text;
begin
  foreach t in array array[
    'ppc_accounts','ppc_campaigns','ppc_campaign_metrics',
    'ppc_keyword_metrics','ppc_search_terms','ppc_geo_metrics',
    'ppc_recommendations'
  ]
  loop
    execute format($f$
      create policy %1$s_org_read on %1$s
        for select using (public.user_in_org(org_id));
    $f$, t);

    execute format($f$
      create policy %1$s_service_write on %1$s
        for all to service_role using (true) with check (true);
    $f$, t);
  end loop;
end$$;

-- Approval actions (status changes on recommendations) are writes by authed
-- users, not just service_role. Add a scoped update policy for that one table:
create policy ppc_recommendations_member_decide on ppc_recommendations
  for update using (public.user_in_org(org_id))
  with check (public.user_in_org(org_id));

-- ---------------------------------------------------------------------------
-- Convenience views for the dashboard + engine
-- ---------------------------------------------------------------------------

-- Zero-conversion paid spend by search term (negative-keyword candidates).
create or replace view ppc_waste_search_terms as
select
  st.org_id,
  c.property_id,
  st.campaign_id,
  st.search_term,
  st.is_branded,
  sum(st.cost_micros)  as cost_micros,
  sum(st.clicks)       as clicks,
  sum(st.conversions)  as conversions
from ppc_search_terms st
join ppc_campaigns c on c.id = st.campaign_id
where st.added_as_negative = false
group by st.org_id, c.property_id, st.campaign_id, st.search_term, st.is_branded
having sum(st.conversions) = 0 and sum(st.cost_micros) > 0;

-- Marginal CPA by campaign over trailing window (reallocation engine input).
create or replace view ppc_campaign_cpa as
select
  m.org_id,
  c.property_id,
  m.campaign_id,
  c.name,
  sum(m.cost_micros)   as cost_micros,
  sum(m.conversions)   as conversions,
  case when sum(m.conversions) > 0
       then sum(m.cost_micros) / sum(m.conversions)
       else null end   as cpa_micros,
  max(m.search_budget_lost_impression_share) as budget_lost_is
from ppc_campaign_metrics m
join ppc_campaigns c on c.id = m.campaign_id
group by m.org_id, c.property_id, m.campaign_id, c.name;
