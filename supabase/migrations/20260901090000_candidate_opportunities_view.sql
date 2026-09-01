-- Opportunity Intelligence Phase 2.3c — the candidate-facing Opportunities
-- read model, so the list can be ordered and paginated in SQL instead of
-- fetching every verified vacancy and sorting in JS.
--
-- SECURITY MODEL — read this before changing anything here.
--
-- `security_invoker = on` is load-bearing, not decoration. It makes the
-- view execute under the CALLING user's privileges and RLS policies, so
-- application_plans_select_own and fit_analyses_select_own filter the two
-- joined tables to the caller's own rows. That is what lets the body below
-- carry no auth.uid() predicate of its own: each LEFT JOIN can only ever
-- match the caller's row, and both tables are unique per
-- (candidate_id, vacancy_id), so a vacancy yields exactly one view row.
--
-- Without security_invoker the view would run as its owner, RLS on those
-- tables would NOT apply, and every candidate would see every other
-- candidate's fit analysis. The pgTAP suite asserts the reloption
-- explicitly for that reason.
--
-- This is deliberately the OPPOSITE choice from company_reviews_public
-- (20260825050000), which relies on default definer semantics to publish
-- an anonymized slice of an RLS-protected table. Same file conventions,
-- inverted intent — the two sit side by side, so the distinction is called
-- out here rather than left to be inferred.
--
-- NOT SAFE FOR service_role. A service-role query bypasses RLS, so the
-- fit_analyses/application_plans joins fan out to one row per candidate per
-- vacancy. This view is candidate-facing only; workers must keep reading
-- the base tables directly.
--
-- vacancy_trust_scores is deliberately NOT joined. Its only `authenticated`
-- grant is gated by a moderator policy (20260816222829), so a candidate's
-- read of it returns zero rows — the client's `trustScore` field has been
-- structurally null since Phase 2.2 and its UI never rendered. Joining a
-- guaranteed-null column into the read model would preserve dead weight;
-- the field is dropped from the client in this phase instead. A
-- moderator-facing surface, if one is ever built, reads the table directly.
--
-- The WHERE clause holds the list's definition of an "opportunity"
-- (verified + still live), matching what listOpportunities filtered on
-- before. Trust states outside this set are not candidate-visible here.
create view public.candidate_opportunities
  with (security_invoker = on) as
  select
    v.id,
    v.raw_title,
    v.authoritative_url,
    v.country,
    v.region,
    v.city,
    v.remote_type,
    v.currency,
    v.salary_min,
    v.salary_max,
    v.salary_interval,
    v.salary_source,
    v.discovered_at,
    v.last_seen_at,
    v.expires_at,
    v.trust_status,

    c.displayed_name as company_name,
    c.domain         as company_domain,

    -- At most one plan per (candidate, vacancy), so gate_results is a scalar
    -- here rather than the array the old PostgREST embed returned.
    --
    -- The lifecycle status lives on application_attempts, NOT on
    -- application_plans — a plan can have several attempts over time, so the
    -- lateral picks the most recent one. (The pre-2.3c client selected a
    -- non-existent application_plans.status and its whole query 400'd; the
    -- view is built against the real schema and pgTAP checks it.)
    ap.gate_results     as plan_gate_results,
    latest.status       as attempt_status,

    fa.technical_fit_score,
    fa.practical_eligibility_score,
    fa.eligibility_capped,
    fa.hard_blockers,
    fa.missing_evidence,
    fa.top_reasons,
    fa.jd_text_available,

    -- Phase 2.3b stored score. priority_score is the ORDER BY key; the
    -- client refreshes the urgency slice from priority_components on read,
    -- so a displayed score can differ from this by at most urgency's weight.
    fa.priority_score,
    fa.priority_uncapped_score,
    fa.priority_components,
    fa.priority_score_version
  from public.vacancies v
  left join public.companies c on c.id = v.company_id
  left join public.application_plans ap on ap.vacancy_id = v.id
  left join lateral (
    select aa.status
    from public.application_attempts aa
    where aa.application_plan_id = ap.id
    order by aa.created_at desc
    limit 1
  ) latest on true
  left join public.fit_analyses fa on fa.vacancy_id = v.id
  where v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE')
    and v.status = 'active';

-- Same defense-in-depth ordering as every prior migration: strip what
-- Supabase's base template pre-grants, then grant back only this slice.
revoke all on public.candidate_opportunities from public;
revoke all on public.candidate_opportunities from anon;
revoke all on public.candidate_opportunities from authenticated;

grant select on public.candidate_opportunities to authenticated;

-- Supports the view's ORDER BY priority_score DESC NULLS LAST, scoped to
-- one candidate's rows. Note this is NOT (candidate_id, vacancy_id,
-- priority_score): the join lookup is already served by the unique index
-- fit_analyses' `unique (candidate_id, vacancy_id)` constraint creates. It
-- is the sort, not the join, that lacked index support.
--
-- ponytail: cheap insurance rather than a measured win — at current row
-- counts the planner will sort in memory either way. Kept because
-- pagination makes the ordering a permanent, per-request cost.
create index fit_analyses_candidate_priority_idx
  on public.fit_analyses (candidate_id, priority_score desc nulls last);
