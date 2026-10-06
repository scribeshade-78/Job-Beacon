-- D1-RANK — the candidate-scoped RANKED opportunities read model.
--
-- WHAT THIS ADDS, AND WHY IT MUST BE IN SQL. The feed could not order by the
-- candidate's preference qualifiers: the relevance rule is the TypeScript
-- matcher (shared/roleTaxonomy.ts) and the token rule is the TypeScript
-- tokenizer (shared/evidenceTokens.ts), neither of which SQL may reimplement.
-- The derived tables already persist their RESULTS (candidate_role_matches,
-- candidate_qualifier_tokens, vacancy_evidence_tokens); this migration joins
-- them into one ranked read model, so ordering and pagination stay in SQL and
-- the ready path needs NO render-time role filtering.
--
-- APPLICABILITY IS EVALUATED INSIDE THIS QUERY'S SNAPSHOT, not authorized by an
-- earlier TypeScript check. A separate loader's verdict would prove only what the
-- data was at that moment; the ranked view therefore compares the recorded
-- derivation inputs with the current candidate rows itself (see the helpers
-- below). A generation whose recorded inputs are absent (legacy) is UNKNOWN and
-- never current: it is never reconstructed as if it had been valid.
--
-- SQL-COMPARABLE INPUTS. The existing fingerprints (role_input_fingerprint,
-- intent_fingerprint, evidence_fingerprint) are TypeScript FNV hashes SQL cannot
-- recompute, so they stay as they are and are joined by canonical JSONB inputs
-- the writers record alongside them:
--   * candidate_role_match_coverage.role_input_canonical  — the selected-role
--     inputs the matching scan actually used.
--   * candidate_qualifier_generations.intent_canonical    — the confirmed intent
--     the derivation actually used.
--   * vacancy_evidence_tokens.input_title / input_clean_text — the exact posting
--     inputs the indexer tokenized, compared against the CURRENT title and the
--     snapshot the indexer's own rule selects.
-- Canonical inputs are compared by EQUALITY only; this migration never
-- re-derives tokens or re-runs the role matcher.
--
-- ORDERING (best match, ranking current):
--   matched_qualifier_count DESC, priority_score DESC NULLS LAST,
--   last_seen_at DESC NULLS LAST, id ASC.
-- The qualifier key is chosen by the client only when the ranking state is
-- current; the deterministic id tie-break is what makes paging stable.
--
-- COUNTS. Pagination uses an exact filtered count over this same eligible set,
-- taken before the page range, so hasMore cannot disagree with the page.
--
-- WHAT THIS DOES NOT DO. It does not write anything, does not call a model, does
-- not submit, and does not activate a task. It is a read model.

-- ---------------------------------------------------------------------------
-- 1. Canonical, SQL-comparable derivation inputs (additive; fingerprints kept).
-- ---------------------------------------------------------------------------
alter table public.candidate_role_match_coverage
  add column role_input_canonical jsonb;

comment on column public.candidate_role_match_coverage.role_input_canonical is
  'The selected-role inputs (sorted array of {role_name}) the matching scan actually used, recorded beside role_input_fingerprint so SQL can compare them with candidate_selected_roles in one snapshot. NULL for rows written before this column existed: those are UNKNOWN and never current.';

alter table public.candidate_qualifier_generations
  add column intent_canonical jsonb;

comment on column public.candidate_qualifier_generations.intent_canonical is
  'The confirmed intent inputs (sorted array of {role_name, raw_role_name}) the derivation actually used, recorded beside intent_fingerprint. NULL for rows published before this column existed: UNKNOWN, never current.';

alter table public.vacancy_evidence_tokens
  add column input_title text,
  add column input_clean_text text;

comment on column public.vacancy_evidence_tokens.input_title is
  'The exact vacancies.raw_title the tokens were derived from. Compared against the CURRENT title; NULL (legacy row) is UNKNOWN and never current.';
comment on column public.vacancy_evidence_tokens.input_clean_text is
  'The exact vacancy_jd_snapshots.clean_text the tokens were derived from, or NULL when no description was indexed. Compared against the snapshot selected by the indexer''s own rule (created_at DESC, id DESC). NULL is ambiguous between "no description" and "legacy", so input_title plus jd_snapshot_id disambiguate with it.';

-- ---------------------------------------------------------------------------
-- 2. Canonical-input builders. These read the candidate's current rows and
--    produce the SAME shape the TypeScript writers record. Deterministic
--    ordering (COLLATE "C" tracks the JS code-unit sort for the ASCII role
--    names this product stores), duplicates preserved exactly as the writers see
--    them, NULL raw intent normalised to the empty string exactly as
--    intentFingerprintOf() does.
-- ---------------------------------------------------------------------------
create function public.candidate_role_inputs_canonical(p_candidate_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('role_name', r.role_name)
      order by r.role_name collate "C"
    ),
    '[]'::jsonb
  )
  from public.candidate_selected_roles r
  where r.candidate_id = p_candidate_id;
$$;

create function public.candidate_intent_canonical(p_candidate_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role_name', r.role_name,
        'raw_role_name', coalesce(r.raw_role_name, '')
      )
      order by r.role_name collate "C", coalesce(r.raw_role_name, '') collate "C"
    ),
    '[]'::jsonb
  )
  from public.candidate_selected_roles r
  where r.candidate_id = p_candidate_id;
$$;

-- The indexer's snapshot-selection rule, in SQL. indexEvidence.ts reduces each
-- batch to the greatest (created_at, id); this is the same rule, so the two
-- cannot disagree about which clean_text is authoritative.
create function public.latest_jd_snapshot_id(p_vacancy_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select s.id
  from public.vacancy_jd_snapshots s
  where s.vacancy_id = p_vacancy_id
  order by s.created_at desc, s.id desc
  limit 1;
$$;

create function public.latest_jd_snapshot_clean_text(p_vacancy_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select s.clean_text
  from public.vacancy_jd_snapshots s
  where s.vacancy_id = p_vacancy_id
  order by s.created_at desc, s.id desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 3. Applicability helpers, evaluated in the caller's snapshot under RLS.
--    Rule versions are constants (role matcher / evidence tokenizer), not
--    reimplementations. A NULL canonical input means UNKNOWN -> not applicable.
-- ---------------------------------------------------------------------------
create function public.role_match_coverage_applies(p_candidate_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.candidate_role_match_coverage c
    where c.candidate_id = p_candidate_id
      and c.published_generation is not null
      and c.corpus_complete is true
      and c.matcher_version = 'role-taxonomy-v1'
      and c.published_corpus_version is not null
      and c.published_corpus_version = public.current_role_match_corpus_version()
      and c.role_input_canonical is not null
      and c.role_input_canonical = public.candidate_role_inputs_canonical(p_candidate_id)
  );
$$;

create function public.qualifier_generation_applies(p_candidate_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.candidate_qualifier_generations g
    where g.candidate_id = p_candidate_id
      and g.tokenizer_version = 'evidence-tokens-v1'
      and g.intent_canonical is not null
      and g.intent_canonical = public.candidate_intent_canonical(p_candidate_id)
  );
$$;

-- True when the published generation actually holds qualifier rows. An
-- EXPLICITLY EMPTY derivation (pointer advanced, zero rows) means there is
-- nothing to boost, so posting evidence must not be required for it.
create function public.qualifier_preferences_present(p_candidate_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.candidate_qualifier_tokens t
    join public.candidate_qualifier_generations g
      on g.candidate_id = t.candidate_id and g.generation = t.generation
    where t.candidate_id = p_candidate_id
  );
$$;

create function public.candidate_has_selected_roles(p_candidate_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.candidate_selected_roles r where r.candidate_id = p_candidate_id
  );
$$;

-- One vacancy's indexed evidence is current only when the tokenizer matches AND
-- the recorded posting inputs equal the current title and the snapshot this
-- rule selects. Tokenizer version alone is deliberately insufficient.
create function public.vacancy_evidence_is_current(p_vacancy_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.vacancy_evidence_tokens e
    join public.vacancies v on v.id = e.vacancy_id
    where e.vacancy_id = p_vacancy_id
      and e.tokenizer_version = 'evidence-tokens-v1'
      and e.input_title is not distinct from v.raw_title
      and e.input_clean_text is not distinct from public.latest_jd_snapshot_clean_text(p_vacancy_id)
      and e.jd_snapshot_id is not distinct from public.latest_jd_snapshot_id(p_vacancy_id)
  );
$$;

-- WHOLE-CORPUS completeness, so the state is assessed BEFORE pagination and a
-- page is never labelled current while another page's rows are unindexed. The
-- browseable predicate mirrors public.candidate_opportunities.
create function public.posting_evidence_complete()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select not exists (
    select 1
    from public.vacancies v
    where v.status = 'active'
      and v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW')
      and not public.vacancy_evidence_is_current(v.id)
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. The ranking state and score.
-- ---------------------------------------------------------------------------
create function public.candidate_ranking_state(p_candidate_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when p_candidate_id is null then 'unavailable'
    when not public.candidate_has_selected_roles(p_candidate_id) then 'no_target_roles'
    when public.role_match_coverage_applies(p_candidate_id) then
      case
        when not public.qualifier_generation_applies(p_candidate_id) then 'updating'
        when not public.qualifier_preferences_present(p_candidate_id) then 'current'
        when public.posting_evidence_complete() then 'current'
        else 'updating'
      end
    when exists (
      select 1 from public.candidate_role_match_coverage c
      where c.candidate_id = p_candidate_id and c.status = 'failed'
    ) then 'unavailable'
    else 'updating'
  end;
$$;

-- ASSOCIATION-PRESERVING DISTINCT COUNT: a qualifier counts once, and only when
-- the vacancy authoritatively matches the ROLE the qualifier belongs to under the
-- PUBLISHED role-match generation, AND the qualifier token is in the CURRENT
-- posting evidence (title + captured clean_text only). Appearing in several
-- matching roles still counts once.
create function public.candidate_ranked_matched_qualifiers(p_candidate_id uuid, p_vacancy_id uuid)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((
    select count(distinct t.qualifier)
    from public.candidate_qualifier_tokens t
    join public.candidate_qualifier_generations g
      on g.candidate_id = t.candidate_id and g.generation = t.generation
    where t.candidate_id = p_candidate_id
      and exists (
        select 1
        from public.candidate_role_matches m
        join public.candidate_role_match_coverage c
          on c.candidate_id = m.candidate_id and c.published_generation = m.generation
        where m.candidate_id = t.candidate_id
          and m.role_name = t.role_name
          and m.vacancy_id = p_vacancy_id
      )
      and exists (
        select 1
        from public.vacancy_evidence_tokens e
        join public.vacancies v on v.id = e.vacancy_id
        where e.vacancy_id = p_vacancy_id
          and e.tokenizer_version = 'evidence-tokens-v1'
          and t.qualifier = any(e.tokens)
          and e.input_title is not distinct from v.raw_title
          and e.input_clean_text is not distinct from public.latest_jd_snapshot_clean_text(p_vacancy_id)
          and e.jd_snapshot_id is not distinct from public.latest_jd_snapshot_id(p_vacancy_id)
      )
  ), 0)::integer;
$$;

-- ---------------------------------------------------------------------------
-- 5. Ranking identity. Includes PUBLICATION identities, not just versions: a
--    re-index that rewrites a row's inputs changes ranking without changing the
--    tokenizer version, so max(indexed_at) and the current-row count travel too.
-- ---------------------------------------------------------------------------
create function public.candidate_ranking_identity(p_candidate_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select concat_ws(
    '|',
    'state=' || public.candidate_ranking_state(p_candidate_id),
    'q=' || coalesce((select g.generation::text from public.candidate_qualifier_generations g where g.candidate_id = p_candidate_id), '-'),
    'r=' || coalesce((select c.published_generation::text from public.candidate_role_match_coverage c where c.candidate_id = p_candidate_id), '-'),
    'cv=' || coalesce((select c.published_corpus_version::text from public.candidate_role_match_coverage c where c.candidate_id = p_candidate_id), '-'),
    'mv=' || coalesce((select c.matcher_version from public.candidate_role_match_coverage c where c.candidate_id = p_candidate_id), '-'),
    'tv=' || coalesce((select g.tokenizer_version from public.candidate_qualifier_generations g where g.candidate_id = p_candidate_id), '-'),
    'ei=' || coalesce((select max(e.indexed_at)::text from public.vacancy_evidence_tokens e), '-'),
    'ec=' || coalesce((select count(*)::text from public.vacancy_evidence_tokens e where e.tokenizer_version = 'evidence-tokens-v1'), '0')
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. The status view: informational, one row for the caller. It never replaces
--    the applicability checks inside candidate_ranked_opportunities.
-- ---------------------------------------------------------------------------
create view public.candidate_ranking_status
  with (security_invoker = on) as
select
  me.candidate_id,
  public.candidate_ranking_state(me.candidate_id) as state,
  public.candidate_ranking_identity(me.candidate_id) as ranking_identity,
  (select c.published_generation from public.candidate_role_match_coverage c where c.candidate_id = me.candidate_id) as role_match_generation,
  (select c.published_corpus_version from public.candidate_role_match_coverage c where c.candidate_id = me.candidate_id) as corpus_version,
  (select c.matcher_version from public.candidate_role_match_coverage c where c.candidate_id = me.candidate_id) as matcher_version,
  (select g.generation from public.candidate_qualifier_generations g where g.candidate_id = me.candidate_id) as qualifier_generation,
  (select g.tokenizer_version from public.candidate_qualifier_generations g where g.candidate_id = me.candidate_id) as tokenizer_version,
  (select max(e.indexed_at) from public.vacancy_evidence_tokens e) as evidence_indexed_at,
  (select count(*) from public.vacancy_evidence_tokens e where e.tokenizer_version = 'evidence-tokens-v1') as evidence_row_count
from (select auth.uid() as candidate_id) me;

comment on view public.candidate_ranking_status is
  'One row for the calling candidate: ranking state plus the publication identities that make it current. Informational only — candidate_ranked_opportunities re-checks applicability itself, so a stale status read can never authorize a ranked page.';

-- ---------------------------------------------------------------------------
-- 7. The ranked read model. Every derived relation is correlated by the CALLER's
--    candidate_id, so no generation can fan out or expose another candidate's
--    data, and the state is materialised once per query.
-- ---------------------------------------------------------------------------
create view public.candidate_ranked_opportunities
  with (security_invoker = on) as
with me as materialized (
  select auth.uid() as candidate_id
),
st as materialized (
  select public.candidate_ranking_state(me.candidate_id) as state from me
)
select
  o.*,
  me.candidate_id as ranking_candidate_id,
  st.state as ranking_state,
  public.candidate_ranking_identity(me.candidate_id) as ranking_identity,
  -- NULL (unavailable) when ranking is not current, so an unranked row can never
  -- read as a confirmed zero match.
  case
    when st.state = 'current'
      then public.candidate_ranked_matched_qualifiers(me.candidate_id, o.id)
    else null
  end as matched_qualifier_count,
  case
    when public.vacancy_evidence_is_current(o.id) then 'current'
    else 'pending'
  end as evidence_state
from public.candidate_opportunities o
cross join me
cross join st
where
  -- CANONICAL ROLE RELEVANCE IS REQUIRED on the ready path, and it is satisfied
  -- from the AUTHORITATIVE materialised matches, never a keyword approximation.
  st.state <> 'current'
  or not public.candidate_has_selected_roles(me.candidate_id)
  or exists (
    select 1
    from public.candidate_role_matches m
    join public.candidate_role_match_coverage c
      on c.candidate_id = m.candidate_id and c.published_generation = m.generation
    where m.candidate_id = me.candidate_id
      and m.vacancy_id = o.id
  );

comment on view public.candidate_ranked_opportunities is
  'Candidate-scoped ranked Opportunities read model, layered on candidate_opportunities. matched_qualifier_count is COUNT(DISTINCT qualifier) whose role this vacancy authoritatively matches, and is NULL unless the ranking state is current. evidence_state marks rows whose indexing is missing/stale. Applicability is recomputed in this query''s snapshot; a separate status read is informational only.';

-- ---------------------------------------------------------------------------
-- 8. Access. Reads only; the underlying tables keep their own RLS.
-- ---------------------------------------------------------------------------
revoke all on public.candidate_ranking_status from public;
revoke all on public.candidate_ranking_status from anon;
revoke all on public.candidate_ranking_status from authenticated;
grant select on public.candidate_ranking_status to authenticated;
grant select on public.candidate_ranking_status to service_role;

revoke all on public.candidate_ranked_opportunities from public;
revoke all on public.candidate_ranked_opportunities from anon;
revoke all on public.candidate_ranked_opportunities from authenticated;
grant select on public.candidate_ranked_opportunities to authenticated;
grant select on public.candidate_ranked_opportunities to service_role;

revoke all on function public.candidate_role_inputs_canonical(uuid) from public;
revoke all on function public.candidate_intent_canonical(uuid) from public;
revoke all on function public.latest_jd_snapshot_id(uuid) from public;
revoke all on function public.latest_jd_snapshot_clean_text(uuid) from public;
revoke all on function public.role_match_coverage_applies(uuid) from public;
revoke all on function public.qualifier_generation_applies(uuid) from public;
revoke all on function public.qualifier_preferences_present(uuid) from public;
revoke all on function public.candidate_has_selected_roles(uuid) from public;
revoke all on function public.vacancy_evidence_is_current(uuid) from public;
revoke all on function public.posting_evidence_complete() from public;
revoke all on function public.candidate_ranking_state(uuid) from public;
revoke all on function public.candidate_ranked_matched_qualifiers(uuid, uuid) from public;
revoke all on function public.candidate_ranking_identity(uuid) from public;

revoke all on function public.candidate_role_inputs_canonical(uuid) from anon;
revoke all on function public.candidate_intent_canonical(uuid) from anon;
revoke all on function public.role_match_coverage_applies(uuid) from anon;
revoke all on function public.qualifier_generation_applies(uuid) from anon;
revoke all on function public.qualifier_preferences_present(uuid) from anon;
revoke all on function public.candidate_has_selected_roles(uuid) from anon;
revoke all on function public.candidate_ranking_state(uuid) from anon;
revoke all on function public.candidate_ranked_matched_qualifiers(uuid, uuid) from anon;
revoke all on function public.candidate_ranking_identity(uuid) from anon;
revoke all on function public.latest_jd_snapshot_id(uuid) from anon;
revoke all on function public.latest_jd_snapshot_clean_text(uuid) from anon;
revoke all on function public.vacancy_evidence_is_current(uuid) from anon;
revoke all on function public.posting_evidence_complete() from anon;

grant execute on function public.candidate_role_inputs_canonical(uuid) to authenticated;
grant execute on function public.candidate_intent_canonical(uuid) to authenticated;
grant execute on function public.latest_jd_snapshot_id(uuid) to authenticated;
grant execute on function public.latest_jd_snapshot_clean_text(uuid) to authenticated;
grant execute on function public.role_match_coverage_applies(uuid) to authenticated;
grant execute on function public.qualifier_generation_applies(uuid) to authenticated;
grant execute on function public.qualifier_preferences_present(uuid) to authenticated;
grant execute on function public.candidate_has_selected_roles(uuid) to authenticated;
grant execute on function public.vacancy_evidence_is_current(uuid) to authenticated;
grant execute on function public.posting_evidence_complete() to authenticated;
grant execute on function public.candidate_ranking_state(uuid) to authenticated;
grant execute on function public.candidate_ranked_matched_qualifiers(uuid, uuid) to authenticated;
grant execute on function public.candidate_ranking_identity(uuid) to authenticated;

grant execute on function public.candidate_role_inputs_canonical(uuid) to service_role;
grant execute on function public.candidate_intent_canonical(uuid) to service_role;
grant execute on function public.latest_jd_snapshot_id(uuid) to service_role;
grant execute on function public.latest_jd_snapshot_clean_text(uuid) to service_role;
grant execute on function public.role_match_coverage_applies(uuid) to service_role;
grant execute on function public.qualifier_generation_applies(uuid) to service_role;
grant execute on function public.qualifier_preferences_present(uuid) to service_role;
grant execute on function public.candidate_has_selected_roles(uuid) to service_role;
grant execute on function public.vacancy_evidence_is_current(uuid) to service_role;
grant execute on function public.posting_evidence_complete() to service_role;
grant execute on function public.candidate_ranking_state(uuid) to service_role;
grant execute on function public.candidate_ranked_matched_qualifiers(uuid, uuid) to service_role;
grant execute on function public.candidate_ranking_identity(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; NOT database tests. The runnable
-- parity fixtures are supabase/tests/database/ranked_opportunities_parity.test.sql
-- and are labelled UNEXECUTED.
--
-- 1. Cross-candidate isolation:
--      -- as candidate B, candidate_ranking_status returns B's candidate_id and
--      -- candidate_ranked_opportunities exposes only B's ranking columns.
--
-- 2. No vacancy duplication:
--      select count(*) = count(distinct id) from public.candidate_ranked_opportunities;
--
-- 3. Legacy inputs are never current:
--      update public.candidate_qualifier_generations set intent_canonical = null
--        where candidate_id = '<c>';
--      -- candidate_ranking_state('<c>') must be 'updating', never 'current'
--
-- 4. Unrelated Azure is excluded, generic relevant is included (see the SQL
--    parity fixture, which builds both rows).
--
-- ROLLBACK
--   drop view if exists public.candidate_ranked_opportunities;
--   drop view if exists public.candidate_ranking_status;
--   drop function if exists public.candidate_ranking_identity(uuid);
--   drop function if exists public.candidate_ranked_matched_qualifiers(uuid, uuid);
--   drop function if exists public.candidate_ranking_state(uuid);
--   drop function if exists public.posting_evidence_complete();
--   drop function if exists public.vacancy_evidence_is_current(uuid);
--   drop function if exists public.candidate_has_selected_roles(uuid);
--   drop function if exists public.qualifier_preferences_present(uuid);
--   drop function if exists public.qualifier_generation_applies(uuid);
--   drop function if exists public.role_match_coverage_applies(uuid);
--   drop function if exists public.latest_jd_snapshot_clean_text(uuid);
--   drop function if exists public.latest_jd_snapshot_id(uuid);
--   drop function if exists public.candidate_intent_canonical(uuid);
--   drop function if exists public.candidate_role_inputs_canonical(uuid);
--   alter table public.vacancy_evidence_tokens drop column input_clean_text, drop column input_title;
--   alter table public.candidate_qualifier_generations drop column intent_canonical;
--   alter table public.candidate_role_match_coverage drop column role_input_canonical;
--   Only derived data is lost; it is reproducible by the writers.
-- ---------------------------------------------------------------------------
