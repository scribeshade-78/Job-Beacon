-- ===========================================================================
-- Enable Greenhouse and Lever for DISCOVERY.
--
-- THE GAP THIS CLOSES. Both adapters (server/ingestion/adapters/greenhouse.ts,
-- lever.ts) and their registry entries have existed for a while, and neither
-- could ever run: server/ingestion/worker.ts refuses to start a discovery job
-- without a matching source_policies row —
--
--   throw policyError ?? new Error(`source_policies row for "${...}" not found.`);
--
-- and there was no such row. Registering an adapter is half the wiring; this is
-- the other half. Verified against the live database before writing: zero rows
-- for either source, and the migration above this one is 20261014120000.
--
-- WHY THE ROWS WERE ABSENT, AND WHY THEY CAN BE ADDED NOW.
-- 20261008000000_production_readiness.sql says, in capitals, "DELIBERATELY NOT
-- HERE: source_policies rows for greenhouse and lever. Do not add them." It gave
-- two reasons, and only ONE of them was about authorization:
--
--   1. Seeding broke 20 pgTAP files that insert their own source_policies
--      fixture row, failing on duplicate key before any assertion ran. THAT WAS
--      A FIXTURE BUG, NOT A REASON TO LEAVE THE SOURCES DEAD, and this migration
--      fixes it at the source: every such fixture insert now ends with
--      "on conflict (source_code) do nothing", so a seeded row is tolerated.
--      Verified afterwards by running the full pgTAP suite.
--
--   2. A hand-written row would assert authorization that does not exist, and
--      the ats_credentials_sync_policy trigger would undo it. THAT REASON
--      APPLIES TO SUBMISSION, NOT DISCOVERY. Greenhouse's own Job Board API
--      documentation says "Job Board data is publicly available, so
--      authentication is not required for any GET endpoints" (quoted in
--      greenhouse.ts). Reading a public board needs no employer permission;
--      POSTING an application does, and that stays off here. Hence
--      automated_application_allowed = false below: this row authorizes exactly
--      what is public and nothing more.
--
-- POLICY REVIEW IS MARKED PENDING, NOT ASSUMED. last_legal_review_at is left
-- NULL and policy_version records the outstanding question, mirroring
-- 20260902000000_jooble_source_policy.sql. Storage and display of board data are
-- governed by each vendor's terms of use, which nobody has reviewed here.
-- ===========================================================================

insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  -- OFF, and the point of the whole comment above. A public board read is not
  -- submission authority; that arrives only with an employer-issued credential
  -- through the ats_credentials_sync_policy trigger.
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values
  ('greenhouse', true, true, true, false, 'none', null, '{}', 'board-api-public-v1', null, false),
  ('lever',      true, true, true, false, 'none', null, '{}', 'board-api-public-v1', null, false)
on conflict (source_code) do nothing;

-- ---------------------------------------------------------------------------
-- Polled targets. A policy row alone discovers nothing: runner.ts selects only
-- enabled vacancy_sources rows, so a source with no target is never polled.
--
-- EVERY target_key BELOW WAS VERIFIED LIVE before being written here, because a
-- wrong board token produces an adapter that returns an empty feed and reports
-- success — the failure looks exactly like a quiet market:
--
--   greenhouse/vercel  HTTP 200, 90 postings, absolute_url on
--                      job-boards.greenhouse.io — which the extension manifest
--                      already matches, so the fill overlay arms on these.
--   greenhouse/stripe  HTTP 200, postings present. CAVEAT: Stripe's absolute_url
--                      points at stripe.com/jobs/search?gh_jid=..., NOT a
--                      greenhouse.io host, so the extension's content script does
--                      not match it. Discovery works; form-filling does not.
--   lever/leverdemo    HTTP 200, exactly 10 postings. This is LEVER'S OWN PUBLIC
--                      DEMO BOARD, chosen deliberately over a real employer:
--                      it proves the pipeline end-to-end without ingesting a
--                      real company's postings while the storage/display review
--                      above is still outstanding. REPLACE IT with a real
--                      employer board before this feed is shown to candidates —
--                      (spotify and toptal both returned HTTP 200 with postings
--                      when checked).
--
-- target_key is the provider's own identifier: a Greenhouse board_token, a Lever
-- site slug. config.companyName is REQUIRED — Greenhouse's jobs-list response
-- contains no company name at all, so greenhouse.ts reads it from here and
-- validateConfig throws when it is missing or empty.
-- ---------------------------------------------------------------------------
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values
  ('greenhouse', 'vercel',   jsonb_build_object('companyName', 'Vercel', 'companyDomain', 'vercel.com'), true),
  ('greenhouse', 'stripe',   jsonb_build_object('companyName', 'Stripe', 'companyDomain', 'stripe.com'), true),
  ('lever',      'leverdemo', jsonb_build_object('companyName', 'Lever (demo board)', 'companyDomain', 'lever.co'), true)
on conflict (source_code, target_key) do nothing;
