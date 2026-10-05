-- D1/Q1 — DERIVED candidate qualifier tokens, so query-time scoring can
-- intersect two token sets by equality rather than re-deriving anything.
--
-- WHY DERIVED AND CANDIDATE-SCOPED. Scoring must answer "which of THIS
-- candidate's preference tokens does this posting's indexed evidence contain".
-- Deriving that per request from candidate_selected_roles is impossible in an
-- ORDER BY (PostgREST orders by columns), and doing it with a text match would be
-- the second matcher this whole design exists to avoid. So the qualifier tokens
-- are derived ONCE from confirmed intent by the shared TS rule and persisted
-- here, per candidate, keyed by the canonical role they belong to.
--
-- ROLE ASSOCIATION IS PART OF THE KEY, NOT DECORATION. A qualifier is only
-- meaningful for the role the candidate attached it to: a "Azure" preference
-- stored against "Data Engineer" must never boost a Teacher posting. The primary
-- key carries role_name so a later join can require that the posting actually
-- matches that role.
--
-- VERSIONED AND FINGERPRINTED, so intent EDITS, CLEARING, role REMOVAL and
-- tokenizer changes are all detectable:
--   * clearing or editing raw_role_name changes intent_fingerprint;
--   * removing a selection deletes its rows (the refresh is a replace);
--   * a tokenizer change invalidates every row via tokenizer_version.
--
-- LEGACY UNKNOWN INTENT PRODUCES NO ROWS. A selection with raw_role_name NULL has
-- no recorded phrase, so nothing is derived for it — a missing row means "no
-- recorded preference", never a guessed one.
--
-- OWNERSHIP. Candidates may only READ their own rows; the derivation is written
-- by the service-role refresh path, which scopes every statement by candidate_id
-- because RLS does not apply to service_role.
create table public.candidate_qualifier_tokens (
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,

  -- The canonical role this qualifier belongs to; qualifiers never float free.
  role_name text not null,
  qualifier text not null,

  tokenizer_version text not null,
  intent_fingerprint text not null,

  refreshed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  primary key (candidate_id, role_name, qualifier)
);

create index candidate_qualifier_tokens_candidate_id_idx
  on public.candidate_qualifier_tokens (candidate_id);

alter table public.candidate_qualifier_tokens enable row level security;

revoke all on public.candidate_qualifier_tokens from public;
revoke all on public.candidate_qualifier_tokens from anon;
revoke all on public.candidate_qualifier_tokens from authenticated;

-- Read-your-own only. No INSERT/UPDATE/DELETE grant to authenticated: derived
-- data is authoritative and service-role-written, so a candidate cannot forge a
-- preference that boosts their own feed.
grant select on public.candidate_qualifier_tokens to authenticated;
grant select, insert, update, delete on public.candidate_qualifier_tokens to service_role;

create policy "candidate_qualifier_tokens_select_own"
  on public.candidate_qualifier_tokens
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

comment on table public.candidate_qualifier_tokens is
  'Derived preference tokens for one candidate, per canonical role, produced ONLY by the shared TS rule from confirmed raw intent. Query-time scoring intersects these with vacancy_evidence_tokens for the SAME matched role. A missing row means no recorded preference (or not yet refreshed) — never a guessed qualifier.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; not a database test.
--
-- 1. Legacy intent derives nothing:
--      select count(*) from public.candidate_qualifier_tokens;  -- only rows for
--      -- selections whose raw_role_name is not null
--
-- 2. Cross-candidate isolation (as candidate B):
--      select count(*) from public.candidate_qualifier_tokens;  -- only B's rows
--      insert into public.candidate_qualifier_tokens ...          -- expect 42501
--
-- 3. Role association survives:
--      select role_name, qualifier from public.candidate_qualifier_tokens
--      where candidate_id = '<uuid>';   -- 'azure' must sit beside its role
--
-- ROLLBACK
--   drop table if exists public.candidate_qualifier_tokens;
--   Only derived data is lost; it is reproducible by the refresh path.
-- ---------------------------------------------------------------------------
