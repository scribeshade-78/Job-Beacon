-- Task W: the Remotive live-intake source.
--
-- WHAT THIS ENABLES. server/intake discovers real, currently-open remote job
-- postings from Remotive's public API and writes them into vacancies, so the
-- pipeline no longer depends on hand-seeded local fixture rows.
--
-- TERMS. Remotive's API response carries its own notice, quoted here because
-- the policy row below is a decision about it and the decision should not be
-- separable from the text it was made about:
--
--   "API documentation and access is granted so that developers can share our
--    jobs further. Please do not submit Remotive jobs to third Party websites,
--    including but not limited to: Jooble, Neuvoo, Google Jobs, LinkedIn Jobs.
--    Please link back to the URL found on Remotive AND mention Remotive as a
--    source in order to Remotive to get traffic from your listing. If you don't
--    do that, we'll terminate your API access, sorry! Jobs displayed are
--    delayed by 24 hours."
--
-- THE REVIEWED POSITION, and the reasoning, so a later reader can disagree with
-- it on the merits rather than having to reconstruct it:
--
--   * The prohibition is on republishing Remotive's listings to third-party
--     job sites. JobBeacon is not a job board: it is a private per-candidate
--     engine that holds postings in a local database for one person to evaluate
--     and apply to. Nothing here is republished or redistributed.
--   * The two conditions that ARE required are implemented rather than assumed:
--     authoritative_url is Remotive's own URL (link back), and
--     candidate_opportunities now exposes source_code so the UI can name
--     Remotive as the source.
--   * The 24-hour delay is real and is why this source is described as
--     "currently-open", not "live": the API is explicitly not a real-time feed.
--
-- last_legal_review_at is set to now() honestly: a review of that notice
-- genuinely happened and reached the position above. It does NOT mean the terms
-- were found unproblematic — policy_version says which reading was adopted.
--
-- automated_application_allowed is false, and that is the load-bearing value.
-- evaluateSourcePolicy is (discovery_allowed AND automated_application_allowed),
-- so these vacancies are discoverable and displayable but NEVER appliable: no
-- adapter submits to Remotive, and nothing in this repository has reviewed
-- automating an application against a listing Remotive syndicated from someone
-- else. The clauses above make that the only defensible setting.
insert into public.source_policies (
  source_code,
  discovery_allowed,
  storage_allowed,
  display_allowed,
  automated_application_allowed,
  authentication_method,
  rate_limit,
  countries,
  policy_version,
  last_legal_review_at,
  kill_switch
)
values (
  'remotive',
  true,
  true,
  true,
  false,
  'none',
  null,
  '{}',
  'remotive-private-intake-v1',
  now(),
  false
)
on conflict (source_code) do nothing;

-- enabled = false: this source is driven ON DEMAND by the discover_live_jobs
-- MCP tool, not polled on a schedule. Leaving it enabled would hand it to
-- runIngestionBatch, which would poll a third-party API on every scheduler tick
-- whether or not anyone asked for jobs — the opposite of what an agent-triggered
-- intake is for.
insert into public.vacancy_sources (source_code, target_key, config, enabled)
values ('remotive', 'remotive-live', '{}'::jsonb, false)
on conflict (source_code, target_key) do nothing;

-- ---------------------------------------------------------------------------
-- Source attribution in the candidate read model.
--
-- Required by the notice above ("mention Remotive as a source"). Without it the
-- UI can render a listing and its link but cannot say where it came from, which
-- would leave the link-back condition only half met.
--
-- create or replace view can only APPEND columns, never insert or reorder them,
-- which is exactly what this does: source_code goes on the end, and every
-- existing column keeps its name, type and position so security_invoker and the
-- client's VIEW_COLUMNS selection are unaffected.
-- ---------------------------------------------------------------------------
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

    v.source_code
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
  'Candidate-facing Opportunities read model. Exposes VERIFIED, VERIFIED_INCOMPLETE and UNDER_REVIEW active vacancies; UNDER_REVIEW rows must be rendered with an unverified-source warning. FLAGGED/BLOCKED/EXPIRED_REMOVED/ACTION_REQUIRED are deliberately excluded. security_invoker = on is load-bearing for candidate scoping. source_code is exposed for source attribution (Remotive requires it).';
