-- Appeals of a moderation decision (PRD §20.3: "Separate reviewer from
-- original decision. Evidence submission deadline. ... Decision rationale
-- and policy citation. ... Full immutable history"). Appeals a specific
-- decision (not just a case) — moderation_decision_id is what the
-- reviewer-separation trigger (see the next migration) checks against.
--
-- §20 frames appeals as employer-authored ("Employer Claim, Correction and
-- Appeals", requiring an MFA-protected employer account per §20.1). No
-- employer auth/account system exists anywhere in this codebase yet — R1
-- only built candidate auth, and companies has no owner/claimant link to
-- any user. Per explicit user decision: schema now, service_role only —
-- filer_id is a generic auth.users reference so the column shape is
-- correct once an employer-claim system exists, but nothing can file one
-- through the app yet; that's a later mini-phase, not invented here.
create table public.vacancy_appeals (
  id uuid primary key default gen_random_uuid(),
  moderation_decision_id uuid not null references public.moderation_decisions (id),
  filer_id uuid not null references auth.users (id),

  rationale text not null,
  evidence jsonb,
  evidence_deadline timestamptz,

  created_at timestamptz not null default now()
);

create index vacancy_appeals_moderation_decision_id_idx on public.vacancy_appeals (moderation_decision_id);
create index vacancy_appeals_filer_id_idx on public.vacancy_appeals (filer_id);

alter table public.vacancy_appeals enable row level security;

revoke all on public.vacancy_appeals from public;
revoke all on public.vacancy_appeals from anon;
revoke all on public.vacancy_appeals from authenticated;

grant select, insert, update, delete on public.vacancy_appeals to service_role;
