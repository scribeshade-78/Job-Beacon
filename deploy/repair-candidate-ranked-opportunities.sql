-- ---------------------------------------------------------------------------
-- ONE-OFF REPAIR (production only). Not a migration — the repo is already correct.
--
-- WHY THIS IS NEEDED. candidate_ranked_opportunities is defined as
--   select o.*, ... from public.candidate_opportunities o
-- so its column list is a SNAPSHOT of candidate_opportunities taken when the
-- view was created. Production applied 20261001340000 BEFORE 20261001180000
-- (out of order), so the view froze without attempt_accepted_evidence while the
-- base view later gained it. A fresh in-order replay is NOT affected: 180000
-- (v18) runs before 134000 (v34), so the view is created after the column exists.
--
-- SAFETY. 180000 appends attempt_accepted_evidence LAST on candidate_opportunities,
-- and o.* expands in column order, so CREATE OR REPLACE VIEW appends it last on
-- the ranked view too — the only change Postgres permits on a replaced view.
-- No column is renamed, reordered or dropped. No data is touched.
--
-- STATUS: APPLIED TO PRODUCTION 2026-10-07, and the feed was verified live
-- afterwards (candidate_ranked_opportunities.attempt_accepted_evidence returns 200
-- and Find Jobs renders). Kept in the repository as the auditable record of what
-- was run against production. Safe to re-run: CREATE OR REPLACE is idempotent.
-- ---------------------------------------------------------------------------
create or replace view public.candidate_ranked_opportunities
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
