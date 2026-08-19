-- Candidate confirmation of an extracted fact (R4.6; PRD §21.1 Resume
-- domain). One row per extracted_facts row — extracted_fact_id is this
-- table's own primary key, the same 1:1-companion-row shape as
-- automation_authorizations (candidate_id primary key), rather than a
-- surrogate id plus a unique constraint, since a fact has at most one
-- current confirmation state.
--
-- No candidate_id column of its own: ownership is transitive through
-- extracted_facts.candidate_id, same "no direct candidate_id, transitively
-- owned" shape as application_attempts/application_evidence.
--
-- Candidates get SELECT + UPDATE only, not INSERT/DELETE: the row's
-- existence follows from an extracted_facts row existing (system-generated,
-- candidate-SELECT-only per that migration), so a candidate can review and
-- flip status between confirmed/rejected/pending, but cannot manufacture a
-- confirmation for a fact that doesn't exist, or delete the record that one
-- was ever reviewed.
create table public.fact_confirmations (
  extracted_fact_id uuid primary key references public.extracted_facts (id),

  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.fact_confirmations enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.fact_confirmations from public;
revoke all on public.fact_confirmations from anon;
revoke all on public.fact_confirmations from authenticated;

grant select, update on public.fact_confirmations to authenticated;
grant select, insert, update, delete on public.fact_confirmations to service_role;

create policy "fact_confirmations_select_own"
  on public.fact_confirmations
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.extracted_facts ef
      where ef.id = fact_confirmations.extracted_fact_id
        and ef.candidate_id = (select auth.uid())
    )
  );

create policy "fact_confirmations_update_own"
  on public.fact_confirmations
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.extracted_facts ef
      where ef.id = fact_confirmations.extracted_fact_id
        and ef.candidate_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.extracted_facts ef
      where ef.id = fact_confirmations.extracted_fact_id
        and ef.candidate_id = (select auth.uid())
    )
  );
