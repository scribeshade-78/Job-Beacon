-- "One canonical vacancy may map to multiple source records" (§21.2).
-- vacancies itself carries its primary/first-seen source identity directly
-- (§11.2's Identity field group lists source_vacancy_id/source_code/
-- authoritative_url alongside the vacancy's other fields). This table is
-- the auxiliary many-side: every source-listing matched to a vacancy_id —
-- including the primary one, so "source evidence" (§21.1, and the
-- Opportunities screen's evidence link/freshness/source per §18.2) is
-- always queryable in one place regardless of how many sources found it.
--
-- Populated by dedup rules 1 and 2 (§11.3) only: exact source-ID match
-- (trivial — enforced by the unique constraint below) and canonical URL
-- match (a later fetch's authoritative_url equals an existing vacancy's).
-- Rules 3-6 (fingerprint, semantic similarity, cross-source career-page
-- confirmation, repost-version relationship) are NOT implemented here —
-- fingerprint matching is handled separately by vacancy_fingerprints;
-- semantic similarity needs embeddings/NLP (out of scope, same category
-- of deferral as R1's AI-dependent items); the other two need correlation
-- logic beyond R2 foundation scope.
create table public.vacancy_source_records (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,
  source_code text not null references public.source_policies (source_code),
  source_vacancy_id text not null,
  authoritative_url text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (source_code, source_vacancy_id)
);

create index vacancy_source_records_vacancy_id_idx on public.vacancy_source_records (vacancy_id);

alter table public.vacancy_source_records enable row level security;

revoke all on public.vacancy_source_records from public;
revoke all on public.vacancy_source_records from anon;
revoke all on public.vacancy_source_records from authenticated;

-- Candidate-facing evidence (PRD §18.2: "Freshness and source", "Evidence
-- link"). SELECT only.
grant select on public.vacancy_source_records to authenticated;
grant select, insert, update, delete on public.vacancy_source_records to service_role;

create policy "vacancy_source_records_select_all"
  on public.vacancy_source_records
  for select
  to authenticated
  using (true);
