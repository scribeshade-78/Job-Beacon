-- Audit trail for employer_claims moderator decisions (R5.4a; PRD §20.1's
-- "audit" requirement). Append-oriented — a claim can be reviewed more
-- than once (rejected, then reconsidered on resubmission), so decisions
-- are their own history, not overwritten fields on employer_claims, same
-- "append-oriented chain, not an overwritten single record" reasoning
-- company_legal_entities' own comment gives for a near-identical shape.
create table public.employer_claim_decisions (
  id uuid primary key default gen_random_uuid(),
  employer_claim_id uuid not null references public.employer_claims (id) on delete cascade,
  reviewer_id uuid not null references auth.users (id),

  decision text not null check (decision in ('verified', 'rejected')),
  rationale text not null,

  created_at timestamptz not null default now()
);

create index employer_claim_decisions_employer_claim_id_idx on public.employer_claim_decisions (employer_claim_id);

alter table public.employer_claim_decisions enable row level security;

revoke all on public.employer_claim_decisions from public;
revoke all on public.employer_claim_decisions from anon;
revoke all on public.employer_claim_decisions from authenticated;

grant select on public.employer_claim_decisions to authenticated;
grant select, insert, update, delete on public.employer_claim_decisions to service_role;

-- Same transitive-ownership shape as messages_select_own: the employer
-- can see the rationale behind a decision on their own claim (e.g. why it
-- was rejected), without a direct employer_claim_decisions grant.
create policy "employer_claim_decisions_select_own"
  on public.employer_claim_decisions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.employer_claims ec
      where ec.id = employer_claim_decisions.employer_claim_id
        and ec.user_id = (select auth.uid())
    )
  );
