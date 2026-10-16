-- A rank that makes "verified first" expressible in an ORDER BY.
--
-- THE PROBLEM. best_match ordered by priority_score DESC NULLS LAST, then last_seen_at DESC.
-- Only the handful of scored rows had a score, so the entire unscored corpus fell through to
-- recency — and the most recently ingested rows were the adzuna UNDER_REVIEW postings from the
-- last discovery run. A candidate's first page was therefore a wall of unverified aggregator
-- listings while 736 VERIFIED greenhouse/lever postings sat behind them, unreachable without
-- paging. Recency is the right final tiebreak; it is the wrong primary one.
--
-- WHY A COLUMN AND NOT AN ORDER BY EXPRESSION. PostgREST orders by a COLUMN name, so the
-- ranking has to exist as one. trust_status itself cannot serve: it is TEXT, and an
-- alphabetical order puts VERIFIED_INCOMPLETE ahead of VERIFIED, which is the weaker claim
-- first. Hence an explicit rank.
--
-- WHY ONLY THE RANKED VIEW. The client reads candidate_ranked_opportunities everywhere ("so a
-- caller cannot accidentally page the unranked base view"), so the rank only has to exist
-- there. Restating one view definition instead of two also keeps this migration reviewable.
--
-- DEPLOYMENT ORDERING -- MIGRATION FIRST, THEN CLIENT, the same requirement the fit-reasoning
-- and acceptance-evidence migrations record. The client will order by trust_rank; against an
-- un-migrated database that order clause fails with 42703 and the feed renders its error state
-- instead of the list.
--
-- APPENDED, because CREATE OR REPLACE VIEW can only add columns at the end. The view's existing
-- 40 columns are restated in their current order for that reason.

create or replace view public.candidate_ranked_opportunities
  with (security_invoker = on) as
with me as materialized (
  select auth.uid() as candidate_id
),
st as materialized (
  select public.candidate_ranking_state(me.candidate_id) as state from me
)
select
  o.id,
  o.raw_title,
  o.authoritative_url,
  o.country,
  o.region,
  o.city,
  o.remote_type,
  o.currency,
  o.salary_min,
  o.salary_max,
  o.salary_interval,
  o.salary_source,
  o.discovered_at,
  o.last_seen_at,
  o.expires_at,
  o.trust_status,
  o.company_name,
  o.company_domain,
  o.plan_gate_results,
  o.attempt_status,
  o.technical_fit_score,
  o.practical_eligibility_score,
  o.eligibility_capped,
  o.hard_blockers,
  o.missing_evidence,
  o.top_reasons,
  o.jd_text_available,
  o.priority_score,
  o.priority_uncapped_score,
  o.priority_components,
  o.priority_score_version,
  o.source_code,
  o.attempt_accepted_evidence,
  me.candidate_id as ranking_candidate_id,
  st.state as ranking_state,
  public.candidate_ranking_identity(me.candidate_id) as ranking_identity,
  case
    when st.state = 'current'
      then public.candidate_ranked_matched_qualifiers(me.candidate_id, o.id)
    else null
  end as matched_qualifier_count,
  case
    when public.vacancy_evidence_is_current(o.id) then 'current'
    else 'pending'
  end as evidence_state,
  o.risks,
  o.technical_fit_components,

  -- Appended. Lower sorts first, so 0 is the strongest claim. The ELSE arm is deliberately the
  -- WORST rank rather than a default: the base view only exposes these three statuses today, so
  -- any fourth value is a status this build does not understand, and ranking it above a listing
  -- we can vouch for would be the same mistake in the other direction.
  case o.trust_status
    when 'VERIFIED' then 0
    when 'VERIFIED_INCOMPLETE' then 1
    when 'UNDER_REVIEW' then 2
    else 3
  end as trust_rank
from public.candidate_opportunities o
cross join me
cross join st
where
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
  'Candidate-scoped ranked Opportunities read model, layered on candidate_opportunities. matched_qualifier_count is COUNT(DISTINCT qualifier) whose role this vacancy authoritatively matches, and is NULL unless the ranking state is current. evidence_state marks rows whose indexing is missing/stale. Applicability is recomputed in this query''s snapshot; a separate status read is informational only. risks and technical_fit_components are the fit analysis reasoning. trust_rank orders VERIFIED before VERIFIED_INCOMPLETE before UNDER_REVIEW in best_match: equal priority scores fall back to trust before recency, so freshly ingested unverified postings cannot bury the verified corpus.';
