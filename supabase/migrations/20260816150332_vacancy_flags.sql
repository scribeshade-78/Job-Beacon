-- Reason codes attached to a scoring run (PRD §12.3 hard-block reasons,
-- §12.4 positive reason codes). References the specific
-- vacancy_trust_scores row that produced the flag, not the vacancy
-- directly — flags are immutable facts about one scoring event, consistent
-- with that table's append-only design.
--
-- The check constraint enforces the closed set of 10 hard-block + 7
-- positive codes exactly as PRD §12.3/§12.4 list them — deterministic and
-- testable, per the reason-code discipline this project requires for trust
-- decisions. No `kind` (hard_block vs positive) column: it's fully
-- derivable from which of the two lists a code belongs to, so a redundant
-- column isn't added until a real query need shows up.
create table public.vacancy_flags (
  id uuid primary key default gen_random_uuid(),
  vacancy_trust_score_id uuid not null references public.vacancy_trust_scores (id),

  reason_code text not null check (reason_code in (
    -- PRD §12.3 hard-block reasons
    'PAYMENT_OR_FEE_REQUEST',
    'PHISHING_OR_MALWARE_REDIRECT',
    'COMPANY_IMPERSONATION',
    'UNAUTHORIZED_SOURCE_ACCESS',
    'MLM_OR_PYRAMID_RISK',
    'PREMATURE_BANK_OR_GOVERNMENT_ID_REQUEST',
    'VACANCY_REMOVED',
    'PROHIBITED_OR_ILLEGAL_REQUIREMENT',
    'DOMAIN_MISMATCH_WITH_NO_EXPLANATION',
    'CONFIRMED_MODERATOR_BLOCK',
    -- PRD §12.4 positive reason codes
    'OFFICIAL_CAREER_PAGE_CONFIRMED',
    'ATS_POSTING_CONFIRMED',
    'COMPANY_REGISTRY_CONFIRMED',
    'CORPORATE_DOMAIN_CONFIRMED',
    'RECENT_SOURCE_RECHECK_PASSED',
    'SALARY_EMPLOYER_DISCLOSED',
    'PRIOR_TRUSTED_EMPLOYER_HISTORY'
  )),

  created_at timestamptz not null default now()
);

create index vacancy_flags_vacancy_trust_score_id_idx on public.vacancy_flags (vacancy_trust_score_id);

alter table public.vacancy_flags enable row level security;

revoke all on public.vacancy_flags from public;
revoke all on public.vacancy_flags from anon;
revoke all on public.vacancy_flags from authenticated;

-- Service-role only in R3.1, same reasoning as vacancy_trust_scores.
grant select, insert, update, delete on public.vacancy_flags to service_role;
