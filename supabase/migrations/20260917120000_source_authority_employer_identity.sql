-- Employer identity for aggregator-tier sources — closing the unreachable
-- VERIFIED ceiling.
--
-- THE DEFECT THIS FIXES (measured against a real local stack, not theorised).
-- A live Jooble + USAJOBS ingestion produced 75 vacancies scoring 63-65, every
-- one of them UNDER_REVIEW and therefore invisible to the candidate
-- Opportunities screen (candidate_opportunities filters on
-- trust_status in ('VERIFIED','VERIFIED_INCOMPLETE')). One vacancy's real
-- breakdown:
--
--   employerIdentity     weight 20  fraction 0    points  0   <-- the gap
--   authoritativeSource  weight 20  fraction 1    points 20
--   urlIntegrity         weight 15  fraction 1    points 15
--   freshness            weight 10  fraction 1    points 10
--   contentConsistency   weight 10  fraction 0.5  points  5
--   moderatorHistory     weight 10  fraction 0.5  points  5
--   salaryPlausibility   weight  5  fraction 1    points  5
--   scamSignals          weight 10  fraction 0.5  points  5
--                                                     total 65
--
-- scoreEmployerIdentity is a domain match between the vacancy's
-- authoritative_url host and companies.domain / companies.career_domain.
-- The aggregator adapters set companyDomain to null on purpose — neither
-- Jooble nor USAJOBS knows the employer's own domain — and the URL each one
-- stores is the AGGREGATOR's own (jooble.org/jdp/... and
-- www.usajobs.gov/job/...), which can never match an employer domain. The
-- dimension is therefore structurally unreachable for the whole aggregator
-- tier, and with two further dimensions (contentConsistency, scamSignals)
-- pinned at the documented neutral 0.5 because no signal producer exists
-- yet, the tier's ceiling is 65 against a VERIFIED threshold of 80. No
-- amount of retrying, re-scoring or URL enrichment closes a 15-point gap.
--
-- WHY A PER-SOURCE FLAG RATHER THAN A NEW SCORING PATHWAY. registryVerified
-- is the escape hatch trustScore.ts already documents ("scores full credit
-- when registry verification is present, even without a domain match") — but
-- nothing in this repository ever sets it: server/companies/mcaRegistry.ts
-- targets the India MCA registry, which cannot verify a US employer, so the
-- hatch ships as dead code. This column makes the same idea explicit and
-- per-source: it asserts "this source IS the authoritative system of record
-- for who the employer is", which is a property of the source, not of any
-- individual vacancy or legal-entity lookup.
--
-- WHY ONLY usajobs IS SET TRUE, AND jooble IS DELIBERATELY LEFT FALSE.
-- usajobs.gov is the US federal government's own hiring portal: a listing
-- there is published by a federal agency through the government's own system
-- of record, so employer identity is established by the source rather than
-- inferred — which is exactly the question PRD §12.2's employer-identity
-- dimension asks.
--
-- Jooble is the opposite case and must not be granted this. It is an
-- aggregator that mirrors third-party postings: the measured payload for the
-- 50 ingested vacancies carried only a "source" board (27 fitly.work,
-- 15 ceipal.com, ...) plus an unverified free-text company name, and
-- following its /jdp/ redirect to reach the real employer returned HTTP 403
-- to every server-side request. Marking that tier VERIFIED would not be
-- fixing a scoring bug — it would disable the candidate-safety mechanism the
-- trust score exists to provide, on the tier most likely to carry
-- low-quality listings. Jooble reaching VERIFIED is a job for real employer
-- enrichment, not for this flag.
--
-- DEFAULT FALSE is load-bearing: every existing source keeps byte-identical
-- scoring behaviour until an operator deliberately asserts this property.
alter table public.source_policies
  add column employer_identity_authoritative boolean not null default false;

comment on column public.source_policies.employer_identity_authoritative is
  'True when this source is itself the authoritative system of record for the employer''s identity (e.g. a government hiring portal). Scores trustScore.ts''s employerIdentity dimension full credit without a companies.domain match. Must NOT be set for aggregators that merely mirror third-party postings.';

-- USAJOBS carried no source_policies row in any migration, so a queued
-- USAJOBS ingestion job fails immediately in worker.ts
-- ("source_policies row for \"usajobs\" not found") — the same
-- hard requirement 20260902000000 documents for jooble, and the reason
-- USAJOBS discovery could not run at all before this. Registered with the
-- identical review-pending marker so the outstanding terms review stays
-- visible in the data rather than being forgotten.
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
  'usajobs',
  true,
  true,
  true,
  false,
  'api_key_header',
  'USAJOBS Search API: free with a registered key; each request needs an Authorization-Key header plus a User-Agent set to the registered email address.',
  '{US}',
  'usajobs-tou-review-pending',
  null,
  false
)
on conflict (source_code) do nothing;

update public.source_policies
  set employer_identity_authoritative = true,
      updated_at = now()
  where source_code = 'usajobs';
