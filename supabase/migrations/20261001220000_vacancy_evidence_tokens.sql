-- D1/Q1 — derived posting-evidence tokens, so query-time scoring is a token
-- intersection rather than a second text matcher.
--
-- WHY DERIVED DATA AND NOT A READ-TIME MATCH. Query-time scoring must decide
-- "does this posting mention this qualifier". Doing that with LIKE or a regex at
-- read time would be a SECOND matcher that drifts from the shared TS rule
-- (server-side, "azure" would start matching "Azurea"). Instead the shared
-- tokenizer in shared/evidenceTokens.ts derives the tokens once, they are
-- persisted here, and SQL only intersects sets by equality.
--
-- VERSIONED AND FINGERPRINTED. tokenizer_version records which rule produced the
-- tokens, and evidence_fingerprint records WHICH captured evidence produced them.
-- A row whose version is not current, or whose fingerprint no longer matches the
-- posting's title/description, is STALE: readers must treat it as NOT YET INDEXED
-- for the current rule rather than trusting it. That is what makes a tokenizer
-- change an explicit reindex instead of a silent reinterpretation.
--
-- WHAT MAY BE INDEXED. vacancies.raw_title and vacancy_jd_snapshots.clean_text
-- only. Model output (fit_analyses.technical_fit_components), candidate skills
-- and generated summaries are NOT posting evidence and must never be fed to the
-- tokenizer.
--
-- HISTORICAL / UNINDEXED EVIDENCE IS EXPLICITLY UNKNOWN. A vacancy with no row
-- here has no preference ranking, which must be reported honestly rather than
-- treated as "no qualifier evidence" — those are different claims. This is also
-- why nothing may claim full preference ranking while indexing is incomplete.
--
-- INVALIDATION. This table is derived from vacancy evidence; a re-captured JD
-- snapshot changes the fingerprint and the row is re-indexed by the backfill.
-- Candidate intent changes do NOT touch this table at all — qualifier tokens are
-- derived per request from candidate_selected_roles, so changing a phrase takes
-- effect immediately and needs no reindex here.
create table public.vacancy_evidence_tokens (
  vacancy_id uuid primary key references public.vacancies (id) on delete cascade,

  -- Which snapshot the description tokens came from, for provenance. NULL means
  -- the vacancy had no captured description when it was indexed.
  jd_snapshot_id uuid references public.vacancy_jd_snapshots (id) on delete set null,

  tokenizer_version text not null,
  evidence_fingerprint text not null,
  tokens text[] not null default '{}',

  indexed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Token membership lookups (qualifier token = ANY(tokens)) are the read pattern.
create index vacancy_evidence_tokens_tokens_idx
  on public.vacancy_evidence_tokens using gin (tokens);

alter table public.vacancy_evidence_tokens enable row level security;

-- Same defense-in-depth ordering as every prior migration.
revoke all on public.vacancy_evidence_tokens from public;
revoke all on public.vacancy_evidence_tokens from anon;
revoke all on public.vacancy_evidence_tokens from authenticated;

-- Tokens are derived from public employer-posting text, the same information a
-- candidate reads by opening the vacancy's canonical URL, so a broad
-- authenticated SELECT mirrors vacancy_jd_snapshots' own policy. Writes are
-- service_role only: nothing here is candidate-authored.
grant select on public.vacancy_evidence_tokens to authenticated;
grant select, insert, update, delete on public.vacancy_evidence_tokens to service_role;

create policy "vacancy_evidence_tokens_select_all"
  on public.vacancy_evidence_tokens
  for select
  to authenticated
  using (true);

comment on table public.vacancy_evidence_tokens is
  'Derived tokens of captured posting evidence (title + vacancy_jd_snapshots.clean_text), produced ONLY by the shared TS tokenizer. Query-time scoring intersects these with a candidate''s qualifier tokens by equality. tokenizer_version/evidence_fingerprint identify staleness; a missing row means NOT INDEXED (unknown), never "no evidence".';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; not a database test.
--
-- 1. Coverage of the current rule:
--      select count(*) from public.vacancy_evidence_tokens
--      where tokenizer_version = 'evidence-tokens-v1';
--
-- 2. Stale rows a reindex must pick up:
--      select count(*) from public.vacancy_evidence_tokens
--      where tokenizer_version <> 'evidence-tokens-v1';
--
-- 3. Token membership is exact, not fuzzy:
--      select vacancy_id from public.vacancy_evidence_tokens
--      where 'azure' = any(tokens);      -- never matches 'azurea'
--
-- 4. Candidates cannot write derived data:
--      -- as authenticated, INSERT into this table must fail with 42501
--
-- ROLLBACK
--   drop table if exists public.vacancy_evidence_tokens;
--   Only derived data is lost; it is reproducible from vacancies and
--   vacancy_jd_snapshots by the backfill.
-- ---------------------------------------------------------------------------
