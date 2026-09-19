-- Surface UNDER_REVIEW opportunities to candidates, with the provenance
-- warning carried by the UI rather than by hiding the row.
--
-- WHY THIS CHANGES. 20260901090000 restricted the candidate Opportunities
-- read model to trust_status in ('VERIFIED','VERIFIED_INCOMPLETE'). That was
-- written when the trust score was expected to produce VERIFIED for
-- ingested vacancies, but it never did for the aggregator tier — Jooble,
-- USAJOBS and Adzuna all set companyDomain to null and store the
-- AGGREGATOR's own URL, so employerIdentity scored 0/20 against an 80-point
-- threshold and every aggregator listing landed in UNDER_REVIEW. The result
-- was an Opportunities screen that was structurally empty for any
-- aggregator-sourced pipeline: a candidate could not see a perfectly
-- relevant job because of a scoring artefact, which is its own failure mode.
--
-- 20260917120000 fixed the half of that which is honestly fixable (a source
-- that IS the employer's system of record, i.e. usajobs, now reaches
-- VERIFIED). The other half cannot be fixed that way: Jooble genuinely
-- cannot establish who the employer is, and granting it identity credit to
-- make a threshold would not be a fix, it would be a lie about listing
-- safety.
--
-- SO THE ROW IS SHOWN AND LABELLED INSTEAD. UNDER_REVIEW means "we could not
-- establish that this employer is who the listing says" — useful information
-- for a candidate, not a reason to withhold the listing. The panel renders
-- these with a distinct "Unverified source" warning badge and an explicit
-- explanation of what is and is not confirmed (PRD §18.2 transparency;
-- §18.4 status never conveyed by color alone).
--
-- WHAT IS DELIBERATELY STILL EXCLUDED: FLAGGED, BLOCKED, EXPIRED_REMOVED
-- and ACTION_REQUIRED. UNDER_REVIEW is "unproven"; those are "known bad or
-- known stale". A candidate-safety surface must not blur the two, and the
-- warning copy in the UI is only honest for the unproven case.
--
-- No column list, type or order changes — create or replace view cannot
-- alter them, and the client's VIEW_COLUMNS selection is unchanged. Only the
-- WHERE clause moves. security_invoker is restated explicitly (rather than
-- relied on to be preserved) because it is load-bearing: without it the
-- fit_analyses/application_plans joins would stop being scoped to the
-- calling candidate and every candidate would see every other candidate's
-- fit analysis.
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
  where v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW')
    and v.status = 'active';

comment on view public.candidate_opportunities is
  'Candidate-facing Opportunities read model. Exposes VERIFIED, VERIFIED_INCOMPLETE and UNDER_REVIEW active vacancies; UNDER_REVIEW rows must be rendered with an unverified-source warning. FLAGGED/BLOCKED/EXPIRED_REMOVED/ACTION_REQUIRED are deliberately excluded. security_invoker = on is load-bearing for candidate scoping.';
