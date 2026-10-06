-- D1 — sparse, candidate-scoped ROLE MATCHES, derived by the authoritative
-- shared TypeScript matcher.
--
-- WHY THIS TABLE EXISTS. Qualifier ranking may only count a preference whose
-- SELECTED ROLE the vacancy actually matches (an "Azure" preference stored
-- against Data Engineer must never boost a Teacher posting). That relevance rule
-- is shared/roleTaxonomy.ts's isTitleRelevantToRole — TypeScript — and SQL cannot
-- call it. Materialising the matches is therefore the only way to keep ordering
-- in SQL without a second, keyword-based relevance matcher, which is explicitly
-- not approved.
--
-- SPARSE, NOT A CROSS PRODUCT. Only matching pairs are stored. An ABSENT row
-- means UNKNOWN, never "not relevant": only COMPLETED coverage for the same role
-- inputs, matcher version and corpus boundary can establish that.
--
-- STAGED GENERATIONS. The primary key INCLUDES generation, deliberately: a
-- replacement scan writes a new generation alongside the old one, so work in
-- progress never destroys data that is already usable. The readable generation is
-- the one named by candidate_role_match_coverage.published_generation, which is
-- advanced only when a scan completes.
create table public.candidate_role_matches (
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  role_name text not null,
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,

  generation uuid not null,
  matcher_version text not null,

  matched_at timestamptz not null default now(),

  primary key (candidate_id, role_name, vacancy_id, generation)
);

create index candidate_role_matches_lookup_idx
  on public.candidate_role_matches (candidate_id, generation, vacancy_id);
create index candidate_role_matches_role_idx
  on public.candidate_role_matches (candidate_id, role_name, generation);

alter table public.candidate_role_matches enable row level security;

revoke all on public.candidate_role_matches from public;
revoke all on public.candidate_role_matches from anon;
revoke all on public.candidate_role_matches from authenticated;

-- Read-your-own only. No mutation grant: derived data is service-role written, so
-- a candidate cannot forge a match that boosts their own feed.
grant select on public.candidate_role_matches to authenticated;
grant select, insert, update, delete on public.candidate_role_matches to service_role;

create policy "candidate_role_matches_select_own"
  on public.candidate_role_matches
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

-- COVERAGE + PROGRESS. One row per candidate. This is what makes "unknown" honest:
-- it records which role inputs and matcher version were scanned, how far the
-- corpus traversal has reached, whether it completed, and what failed.
create table public.candidate_role_match_coverage (
  candidate_id uuid primary key references public.candidate_profiles (id) on delete cascade,

  -- The generation readers may use. Advanced ONLY on completion, so a partial or
  -- failed scan never replaces usable data with nothing.
  published_generation uuid,

  -- The in-flight generation and how far it got. A stable keyset cursor on
  -- vacancy id: new vacancies get higher ids and are picked up by the next scan,
  -- and a deleted vacancy simply stops appearing, so resuming cannot skip rows.
  running_generation uuid,
  corpus_cursor uuid,
  corpus_complete boolean not null default false,

  role_input_fingerprint text,
  matcher_version text not null,

  status text not null default 'idle' check (status in ('idle', 'running', 'complete', 'failed')),

  scanned integer not null default 0,
  matched integer not null default 0,
  last_error text,

  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.candidate_role_match_coverage enable row level security;

revoke all on public.candidate_role_match_coverage from public;
revoke all on public.candidate_role_match_coverage from anon;
revoke all on public.candidate_role_match_coverage from authenticated;

grant select on public.candidate_role_match_coverage to authenticated;
grant select, insert, update, delete on public.candidate_role_match_coverage to service_role;

create policy "candidate_role_match_coverage_select_own"
  on public.candidate_role_match_coverage
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

comment on table public.candidate_role_match_coverage is
  'Per-candidate coverage for derived role matches: which role inputs and matcher version were scanned, the keyset corpus cursor, completion, and the last failure. A missing match row means UNKNOWN until a scan with matching inputs completes; a partial or failed scan is never marked complete and never replaces the published generation.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; NOT database tests.
--
-- 1. Ownership: as another candidate, both tables return zero rows and an insert
--    fails with 42501.
--
-- 2. A failed scan does not publish:
--      update public.candidate_role_match_coverage set status='failed'
--      where candidate_id='<c>';   -- published_generation must be unchanged
--
-- 3. Sparse, not a cross product:
--      select count(*) from public.candidate_role_matches where candidate_id='<c>';
--      -- bounded by (roles x matching vacancies), never roles x all vacancies
--
-- 4. Generation swap leaves the old rows in place until completion.
--
-- ROLLBACK
--   drop table if exists public.candidate_role_matches;
--   drop table if exists public.candidate_role_match_coverage;
--   Only derived data is lost; it is reproducible by the materialiser.
-- ---------------------------------------------------------------------------
