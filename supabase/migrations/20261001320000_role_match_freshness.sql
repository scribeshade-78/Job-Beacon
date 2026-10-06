-- D1 — ROLE-MATCH INPUT FRESHNESS.
--
-- THE DEFECT THIS FIXES. candidate_role_matches was written by
-- materializeRoleMatches.ts without recording WHICH vacancy input produced a
-- match, and candidate_role_match_coverage recorded only the candidate's role
-- inputs and the matcher version. A completed scan therefore could not be shown
-- STALE when the corpus later changed:
--   * a matched vacancy whose title becomes unrelated;
--   * a previously NON-matching vacancy whose title becomes relevant — the case
--     no positive-match fingerprint can ever detect, because the negative result
--     has no row to fingerprint;
--   * a vacancy inserted BEHIND the keyset cursor (vacancies.id is
--     gen_random_uuid(), so a new id is NOT ordered after an old one);
--   * a vacancy deleted, or entering/leaving the browseable set.
--
-- THE FIX, IN TWO PARTS.
--   1. Every match row records the EXACT raw_title string passed to the shared
--      matcher (input_title) beside matcher_version. Legacy rows keep NULL and
--      are UNKNOWN: they are never backfilled from today's title, because that
--      would assert a historical input was examined when it was not.
--   2. A transactional, monotonic corpus version that changes with every
--      relevant vacancy mutation. Coverage records the version a generation
--      STARTED at and the version it PUBLISHED against; readers compare the
--      published version with the current one. This is the only evidence that
--      can establish freshness for NEGATIVE results too.
--
-- WHY A TRIGGER AND A ROW, NOT updated_at OR A SEQUENCE. scoreVacancy writes
-- vacancies.trust_status WITHOUT touching updated_at, so updated_at does not
-- move on the very change (browseable membership) that matters. A sequence is
-- nontransactional: a rolled-back mutation would still consume a value and a
-- committed scan could be declared stale for a change that never happened. A
-- singleton row updated in the same transaction as the mutation is both
-- transactional and monotonic.
--
-- THE CORPUS IS THE BROWSEABLE SET, mirrored exactly from
-- public.candidate_opportunities (20260917130000, 20260917210000):
--   status = 'active' AND trust_status IN
--     ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW').
-- It is deliberately NOT verified-only.
--
-- WHAT COUNTS AS RELEVANT:
--   * insert of a browseable vacancy;
--   * delete of a browseable vacancy;
--   * a vacancy entering or leaving that set;
--   * raw_title changing on a vacancy that is browseable before AND after.
-- A no-op update, a change to any other column, and any change wholly outside
-- the browseable set leave the version untouched, so coverage is not
-- invalidated for changes that cannot affect a role match.
--
-- NOTHING HERE MATCHES POSTINGS. The relevance rule stays in TypeScript
-- (shared/roleTaxonomy.ts, called by materializeRoleMatches.ts); this migration
-- only records inputs and a version, and never re-implements the matcher in SQL.
-- A partial or failed scan is never relabelled with a newer version: a scan that
-- spans a change must be restarted, not published.

-- ---------------------------------------------------------------------------
-- 1. The exact vacancy input each match row was derived from.
-- ---------------------------------------------------------------------------
alter table public.candidate_role_matches
  add column input_title text;

comment on column public.candidate_role_matches.input_title is
  'The EXACT string passed to the authoritative shared matcher for this row. NULL for rows written before input recording existed: those are UNKNOWN and must never be backfilled from a later title as if the historical input had been examined.';

-- ---------------------------------------------------------------------------
-- 2. The transactional, monotonic corpus version.
--
-- Singleton (id boolean primary key default true check (id)), so it cannot grow
-- a second row, and updated IN THE SAME TRANSACTION as the vacancy mutation it
-- describes. Backend-controlled: service_role has the DML grant, candidates have
-- NO table grant and read the value through current_role_match_corpus_version().
-- ---------------------------------------------------------------------------
create table public.vacancy_corpus_version (
  id boolean primary key default true check (id),
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

insert into public.vacancy_corpus_version (id, version) values (true, 1);

alter table public.vacancy_corpus_version enable row level security;

revoke all on public.vacancy_corpus_version from public;
revoke all on public.vacancy_corpus_version from anon;
revoke all on public.vacancy_corpus_version from authenticated;

grant select, insert, update, delete on public.vacancy_corpus_version to service_role;

comment on table public.vacancy_corpus_version is
  'Singleton monotonic version of the browseable vacancy corpus, bumped in the same transaction as every relevant vacancy mutation. Read through current_role_match_corpus_version(); candidates have no direct table grant.';

-- AFTER trigger, so it runs with the mutation and its version bump in one
-- transaction. SECURITY DEFINER with a pinned search_path (the repo convention)
-- so the bump does not depend on the mutating role holding a grant on the
-- version row.
create function public.bump_vacancy_corpus_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  was_browseable boolean;
  is_browseable boolean;
begin
  if tg_op = 'INSERT' then
    is_browseable := new.status = 'active'
      and new.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW');
    if is_browseable then
      update public.vacancy_corpus_version set version = version + 1, updated_at = now() where id;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    was_browseable := old.status = 'active'
      and old.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW');
    if was_browseable then
      update public.vacancy_corpus_version set version = version + 1, updated_at = now() where id;
    end if;
    return old;
  end if;

  -- UPDATE. OLD/NEW comparison is what keeps a no-op update from invalidating
  -- every candidate's coverage.
  was_browseable := old.status = 'active'
    and old.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW');
  is_browseable := new.status = 'active'
    and new.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW');

  if was_browseable is distinct from is_browseable then
    update public.vacancy_corpus_version set version = version + 1, updated_at = now() where id;
  elsif is_browseable and new.raw_title is distinct from old.raw_title then
    update public.vacancy_corpus_version set version = version + 1, updated_at = now() where id;
  end if;

  return new;
end;
$$;

create trigger vacancies_bump_corpus_version
  after insert or update or delete on public.vacancies
  for each row execute function public.bump_vacancy_corpus_version();

-- The candidate READ path for the current version. Narrower than a table grant:
-- authenticated may execute this and nothing else on the version row.
create function public.current_role_match_corpus_version()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select version from public.vacancy_corpus_version where id;
$$;

revoke all on function public.current_role_match_corpus_version() from public;
revoke all on function public.current_role_match_corpus_version() from anon;
grant execute on function public.current_role_match_corpus_version() to authenticated;
grant execute on function public.current_role_match_corpus_version() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Coverage records the corpus version it started and published against.
-- ---------------------------------------------------------------------------
alter table public.candidate_role_match_coverage
  add column running_corpus_version bigint,
  add column published_corpus_version bigint;

comment on column public.candidate_role_match_coverage.running_corpus_version is
  'vacancy_corpus_version when the in-flight generation started. A scan may only be resumed while this still equals the current version; otherwise the generation must be restarted, never relabelled with the newer version.';

comment on column public.candidate_role_match_coverage.published_corpus_version is
  'vacancy_corpus_version the published generation is valid for. NULL on a row published before this column existed: legacy-unknown, never current.';

-- ---------------------------------------------------------------------------
-- 4. Atomic publish: validate the version and advance the pointer in ONE
--    transaction, so a concurrent relevant mutation cannot slip between the two.
--
--    FOR SHARE on the version row makes a concurrent bump wait (or makes this
--    read the post-bump value, which then fails the comparison). A mutation that
--    commits AFTER this function returns leaves the published version behind the
--    new current version, which the read-time comparison reports as stale — so
--    the slip is never silent either way.
--
--    Returns false (publishes nothing) when the version moved or when this
--    generation is no longer the running one. It never matches postings.
-- ---------------------------------------------------------------------------
create function public.publish_role_match_coverage(
  p_candidate_id uuid,
  p_generation uuid,
  p_expected_corpus_version bigint,
  p_scanned integer,
  p_matched integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version bigint;
  updated_rows integer;
begin
  select version into current_version
  from public.vacancy_corpus_version
  where id
  for share;

  if current_version is null or current_version <> p_expected_corpus_version then
    return false;
  end if;

  update public.candidate_role_match_coverage
  set published_generation = p_generation,
      running_generation = null,
      published_corpus_version = p_expected_corpus_version,
      running_corpus_version = null,
      corpus_complete = true,
      status = 'complete',
      scanned = p_scanned,
      matched = p_matched,
      last_error = null,
      updated_at = now()
  where candidate_id = p_candidate_id
    and running_generation = p_generation
    and status = 'running';

  get diagnostics updated_rows = row_count;

  return updated_rows = 1;
end;
$$;

revoke all on function public.publish_role_match_coverage(uuid, uuid, bigint, integer, integer) from public;
revoke all on function public.publish_role_match_coverage(uuid, uuid, bigint, integer, integer) from anon;
revoke all on function public.publish_role_match_coverage(uuid, uuid, bigint, integer, integer) from authenticated;
grant execute on function public.publish_role_match_coverage(uuid, uuid, bigint, integer, integer) to service_role;

comment on function public.publish_role_match_coverage(uuid, uuid, bigint, integer, integer) is
  'Atomically validates vacancy_corpus_version against the version the scan started at and, only if unchanged and this generation is still running, advances published_generation/published_corpus_version. Returns false and publishes nothing otherwise. Worker-only.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; NOT database tests. The executable
-- fixtures live in supabase/tests/database/role_match_freshness.test.sql and are
-- labelled UNEXECUTED.
--
-- 1. The version is monotonic and transactional:
--      select version from public.vacancy_corpus_version;          -- one row
--
-- 2. A no-op update does not move it:
--      update public.vacancies set raw_title = raw_title where id = '<browseable>';
--      -- version unchanged
--
-- 3. Leaving the browseable set moves it:
--      update public.vacancies set trust_status = 'BLOCKED' where id = '<browseable>';
--      -- version + 1
--
-- 4. A stale scan cannot publish:
--      select public.publish_role_match_coverage('<c>', '<gen>', <old_version>, 0, 0);
--      -- expect false, published_generation unchanged
--
-- 5. Candidate access is execute-only on the read function:
--      -- as authenticated: select from public.vacancy_corpus_version fails 42501;
--      --                   execute publish_role_match_coverage fails 42501
--
-- ROLLBACK
--   drop trigger if exists vacancies_bump_corpus_version on public.vacancies;
--   drop function if exists public.publish_role_match_coverage(uuid, uuid, bigint, integer, integer);
--   drop function if exists public.current_role_match_corpus_version();
--   drop function if exists public.bump_vacancy_corpus_version();
--   drop table if exists public.vacancy_corpus_version;
--   alter table public.candidate_role_match_coverage
--     drop column if exists published_corpus_version,
--     drop column if exists running_corpus_version;
--   alter table public.candidate_role_matches drop column if exists input_title;
--   Only derived data and the version are lost; matches are reproducible by the
--   materialiser.
-- ---------------------------------------------------------------------------
