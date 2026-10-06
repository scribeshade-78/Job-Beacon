-- D1 — staged-generation publication for derived qualifier tokens.
--
-- THE DEFECT THIS FIXES. The first refresh implementation deleted the candidate's
-- rows and then inserted the new derivation as two separate statements. If the
-- insert failed — or the process died between them — the candidate was left with
-- NO derived rows, which every reader must interpret as "no recorded preference".
-- A confirmed "Azure preferred" would silently stop ranking, and a concurrent
-- refresh could publish stale intent over newer intent. "Throw after the insert"
-- does not restore what the delete already removed.
--
-- THE FIX: NEVER DELETE BEFORE PUBLISHING. Each refresh derives a NEW generation,
-- writes its rows under that generation, and only then advances a single
-- per-candidate pointer. Readers join through the pointer, so:
--   * a failure before the pointer write leaves the PREVIOUS generation current —
--     the old preferences keep working instead of vanishing;
--   * the pointer write is one statement, so concurrent refreshes cannot
--     interleave rows from two derivations: the last writer's generation becomes
--     current as a whole;
--   * a CONFIRMED EMPTY derivation still advances the pointer, which is what
--     keeps "I cleared my preference" distinguishable from "derivation failed"
--     and from "never derived".
--
-- GENERATION-CONSISTENCY. tokenizer_version is recorded ON the pointer, so
-- evidence, role-match and intent generations cannot be mixed: a pointer written
-- by an older tokenizer is visibly not current.
alter table public.candidate_qualifier_tokens
  add column generation uuid;

-- Rows written before this migration carry no generation. They are NOT part of
-- any published generation, so the pointer join ignores them: historical derived
-- data is treated as UNKNOWN and must be re-derived, never read as current.
comment on column public.candidate_qualifier_tokens.generation is
  'The derivation generation these rows belong to. NULL for rows written before staged publication; those are UNKNOWN and must not be read as current. Readers join through candidate_qualifier_generations.generation.';

create table public.candidate_qualifier_generations (
  candidate_id uuid primary key references public.candidate_profiles (id) on delete cascade,
  generation uuid not null,
  tokenizer_version text not null,
  published_at timestamptz not null default now()
);

alter table public.candidate_qualifier_generations enable row level security;

revoke all on public.candidate_qualifier_generations from public;
revoke all on public.candidate_qualifier_generations from anon;
revoke all on public.candidate_qualifier_generations from authenticated;

-- Read-your-own; the pointer is written only by the service-role refresh path.
grant select on public.candidate_qualifier_generations to authenticated;
grant select, insert, update, delete on public.candidate_qualifier_generations to service_role;

create policy "candidate_qualifier_generations_select_own"
  on public.candidate_qualifier_generations
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);

create index candidate_qualifier_tokens_generation_idx
  on public.candidate_qualifier_tokens (candidate_id, generation);

comment on table public.candidate_qualifier_generations is
  'Per-candidate pointer to the CURRENT published derivation generation. Advanced only after that generation''s rows are fully written, so a failed refresh cannot publish an empty preference cache. tokenizer_version here makes a stale-generation pointer detectable.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; not a database test.
--
-- 1. A failed refresh leaves the previous generation current:
--      -- publish generation A, then attempt generation B and fail before the
--      -- pointer write; select through the pointer => A''s rows, not empty.
--
-- 2. Confirmed-empty is distinguishable from never-derived:
--      select count(*) from public.candidate_qualifier_generations
--      where candidate_id = '<uuid>';        -- 1 row (pointer advanced)
--      select count(*) from public.candidate_qualifier_tokens
--      where candidate_id = '<uuid>' and generation = '<pointer.generation>';
--      -- 0 rows => explicitly confirmed empty, not a failure
--
-- 3. Cross-candidate isolation:
--      -- as another candidate, the generations table returns zero rows and an
--      -- insert fails with 42501
--
-- ROLLBACK
--   alter table public.candidate_qualifier_tokens drop column generation;
--   drop table if exists public.candidate_qualifier_generations;
-- ---------------------------------------------------------------------------
