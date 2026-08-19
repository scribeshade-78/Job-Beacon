-- Minimal fact extraction foundation (R4.6; PRD §21.1 Resume domain,
-- referenced but deferred by eligibilityGate.ts's verified_facts
-- hard-block placeholder). No NLP/ML extraction pipeline exists anywhere
-- in this repository yet — this is schema and RLS only, so a fact row can
-- exist (populated manually or by a later extraction pipeline) for the
-- candidate to review and confirm via fact_confirmations.
--
-- fact_type/fact_value carry no CHECK-constrained enumeration, same
-- reasoning as candidate_selected_roles.role_name: there is no fixed,
-- PRD-defined taxonomy of fact types to enumerate yet.
--
-- source_document_id is NOT NULL — a fact is, by this table's own name,
-- something extracted from a document, not free-standing candidate
-- input (that's what fact_confirmations.status records instead). No
-- ON DELETE CASCADE from resume_documents: once a fact has been recorded
-- (and possibly confirmed), its truth is independent of whether the
-- original resume file is later deleted — same "plain FK, no cascade,
-- for an internal append-oriented chain" precedent as
-- application_attempts.application_plan_id.
create table public.extracted_facts (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,
  source_document_id uuid not null references public.resume_documents (id),

  fact_type text not null,
  fact_value text not null,

  created_at timestamptz not null default now()
);

create index extracted_facts_candidate_id_idx on public.extracted_facts (candidate_id);
create index extracted_facts_source_document_id_idx on public.extracted_facts (source_document_id);

alter table public.extracted_facts enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.extracted_facts from public;
revoke all on public.extracted_facts from anon;
revoke all on public.extracted_facts from authenticated;

-- Candidate-facing read surface only — a fact is system-generated output
-- (the same "application_plans, not candidate-authored" precedent), not a
-- candidate-editable preference like candidate_selected_roles. The
-- candidate's own action lives one table over, in fact_confirmations.
grant select on public.extracted_facts to authenticated;
grant select, insert, update, delete on public.extracted_facts to service_role;

create policy "extracted_facts_select_own"
  on public.extracted_facts
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);
