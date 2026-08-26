-- Employer persona foundation (R5.4a; PRD §20.1 "Claiming a profile").
-- Same "no employer auth/account system exists yet" gap
-- 20260816231315_vacancy_appeals.sql's own comment already flagged — this
-- is that later mini-phase.
--
-- unique(user_id, company_id): mirrors R6.1's mailbox_connections
-- (candidate_id, provider) pair — reclaiming (e.g. after a rejection)
-- updates the one existing row via upsert rather than leaving a stale
-- duplicate.
--
-- domain_verified is a stored signal, not a bypass: per explicit product
-- decision, a clean corporate-domain match alone never auto-verifies a
-- claim — every claim still requires an explicit moderator decision
-- (employer_claim_decisions), consistent with how every other trust
-- decision in this codebase routes through moderation rather than being
-- inferred client- or server-side alone.
--
-- reverification_due_at is schema-ready for §20.1's "audit and annual
-- reverification" — set on verification (verified_at + 1 year), but no
-- worker enforces it yet; same "schema now, consuming feature later"
-- precedent vacancy_appeals itself used.
--
-- No legal_entity_id column: "legal entity matching" (§20.1) is
-- represented as free-text evidence for a moderator to cross-reference
-- against company_legal_entities manually, not a foreign key — nothing in
-- this codebase resolves "does this specific representative have
-- authority over this specific legal entity" (that's real KYB
-- verification, not built anywhere here), so a FK would imply a certainty
-- this claim doesn't actually have.
create table public.employer_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  company_id uuid not null references public.companies (id),

  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),

  representative_name text not null,
  representative_role text not null,
  evidence text,

  domain_verified boolean not null default false,

  verified_at timestamptz,
  reverification_due_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, company_id)
);

create index employer_claims_company_id_idx on public.employer_claims (company_id);
create index employer_claims_status_idx on public.employer_claims (status);

alter table public.employer_claims enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.employer_claims from public;
revoke all on public.employer_claims from anon;
revoke all on public.employer_claims from authenticated;

-- Candidate-facing SELECT only, no candidate INSERT/UPDATE grant: claim
-- submission and moderator decisions both complete via server-side routes
-- under service_role — same "system-generated, worker-written" precedent
-- as mailbox_connections/application_plans.
grant select on public.employer_claims to authenticated;
grant select, insert, update, delete on public.employer_claims to service_role;

create policy "employer_claims_select_own"
  on public.employer_claims
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
