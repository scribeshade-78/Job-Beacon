-- Batch A — the feed must not call a bare 'succeeded' application Applied.
--
-- THE GAP. candidate_opportunities exposes attempt_status but nothing about
-- whether that attempt's acceptance was actually recorded, so client/src/lib/
-- opportunities.ts mapped any 'succeeded' attempt to Completed. That is the same
-- false claim the Applications and MCP surfaces stopped making in
-- 95c7dfd / 3b49478; the feed was the last consumer still making it.
--
-- WHAT THIS ADDS. One boolean, derived for THE SAME ATTEMPT the view already
-- selects. Deliberately NOT "does this plan have any confirmation anywhere":
-- an older attempt's receipt must not validate a different, later attempt, so
-- the EXISTS is correlated to aa.id inside the existing lateral, not to ap.id.
--
-- WHY THE PREDICATES MIRROR isTrustworthyAcceptanceEvidence() EXACTLY
-- (shared/pipelineStages.ts). SQL and TypeScript cannot share code, so they
-- share semantics instead:
--   evidence_type = 'submission_confirmation'  -> the canonical type only the
--                                                 service-role submission path
--                                                 writes (no client INSERT grant)
--   jsonb_typeof(payload) = 'object'           -> a null or array payload is malformed
--   payload <> '{}'::jsonb                     -> empty object proves nothing
--   payload - 'adapterEvidenceType' <> '{}'    -> the wrapper's provenance key
--                                                 must not be the only thing present,
--                                                 so an empty adapter result cannot be
--                                                 dressed up into acceptance
-- Historical rows that fail any of these stay unverified, which is the intended
-- treatment of unknown evidence.
--
-- WHY IT CANNOT DUPLICATE ROWS. The subquery is an EXISTS inside the SAME
-- lateral that already produces at most one row per plan; no join to
-- application_evidence is added to the view's FROM clause.
--
-- CREATE OR REPLACE COMPATIBILITY. The new column is appended LAST (after
-- source_code), and every existing column keeps its name, position and type.
-- PostgreSQL permits only appended columns on CREATE OR REPLACE VIEW; reordering
-- or renaming would be rejected, and would also break the client's
-- VIEW_COLUMNS selection.
--
-- SECURITY. security_invoker = on is preserved verbatim: the view is evaluated
-- with the caller's privileges, so application_plans/fit_analyses RLS still
-- scopes every per-candidate column to the caller. application_evidence's own
-- RLS (application_evidence_select_own) is transitively satisfied because the
-- correlated attempt belongs to the caller's plan.
--
-- DEPLOYMENT ORDERING — MIGRATION FIRST, THEN CLIENT. The client selects
-- attempt_accepted_evidence; against an un-migrated database that select fails
-- with 42703 and the feed shows its error state rather than rendering anything.
-- The client treats a missing or non-true value as NOT accepted, so the failure
-- direction is "not Completed", never a false Applied. Applying this migration
-- before shipping the client is nevertheless required, because the query itself
-- would otherwise error.
create or replace view public.candidate_opportunities
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

    ap.gate_results     as plan_gate_results,
    latest.status       as attempt_status,

    fa.technical_fit_score,
    fa.practical_eligibility_score,
    fa.eligibility_capped,
    fa.hard_blockers,
    fa.missing_evidence,
    fa.top_reasons,
    fa.jd_text_available,

    fa.priority_score,
    fa.priority_uncapped_score,
    fa.priority_components,
    fa.priority_score_version,

    v.source_code,

    -- Appended: acceptance evidence for the SAME attempt as attempt_status.
    latest.accepted_evidence as attempt_accepted_evidence
  from public.vacancies v
  left join public.companies c on c.id = v.company_id
  left join public.application_plans ap on ap.vacancy_id = v.id
  left join lateral (
    select
      aa.status,
      exists (
        select 1
        from public.application_evidence e
        where e.application_attempt_id = aa.id
          and e.evidence_type = 'submission_confirmation'
          and jsonb_typeof(e.payload) = 'object'
          and e.payload <> '{}'::jsonb
          and (e.payload - 'adapterEvidenceType') <> '{}'::jsonb
      ) as accepted_evidence
    from public.application_attempts aa
    where aa.application_plan_id = ap.id
    order by aa.created_at desc
    limit 1
  ) latest on true
  left join public.fit_analyses fa on fa.vacancy_id = v.id
  where v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW')
    and v.status = 'active';

comment on view public.candidate_opportunities is
  'Candidate-facing Opportunities read model. Exposes VERIFIED, VERIFIED_INCOMPLETE and UNDER_REVIEW active vacancies; UNDER_REVIEW rows must be rendered with an unverified-source warning. FLAGGED/BLOCKED/EXPIRED_REMOVED/ACTION_REQUIRED are deliberately excluded. security_invoker = on is load-bearing for candidate scoping. source_code is exposed for source attribution (Remotive requires it). attempt_accepted_evidence is computed for the SAME attempt as attempt_status and mirrors isTrustworthyAcceptanceEvidence(); it must never be treated as true when absent.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; they are not a database test.
--
-- 1. The view still has exactly one row per candidate x vacancy:
--      select count(*) from public.candidate_opportunities;   -- compare to before
--
-- 2. A bare succeeded attempt is NOT accepted:
--      select attempt_status, attempt_accepted_evidence
--      from public.candidate_opportunities
--      where attempt_status = 'succeeded';                     -- expect false/NULL
--
-- 3. An older attempt's confirmation does not validate a later attempt:
--      -- give attempt A a confirmation, then create attempt B on the same plan:
--      -- the view must report attempt B's status with attempt_accepted_evidence = false
--
-- 4. security_invoker survived:
--      select reloptions from pg_class
--      where oid = 'public.candidate_opportunities'::regclass;
--      -- expect {security_invoker=on}
--
-- ROLLBACK
--   Re-apply the definition from
--   20260917210000_remotive_intake_source.sql (identical minus the appended
--   column and the lateral's accepted_evidence), which restores the previous
--   view exactly. No table and no row is modified by this migration.
-- ---------------------------------------------------------------------------
