-- Immutable, versioned raw snapshots (PRD §11.1 step 22 "version changes
-- without overwriting historical evidence"; §21.2 "Raw vacancy snapshots
-- are immutable and versioned"). One row per fetch where the raw payload
-- actually changed — content_hash lets the worker skip creating a
-- no-op version when a re-fetch returns identical content.
create table public.vacancy_versions (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,
  raw_payload jsonb not null,
  content_hash text not null,
  fetched_at timestamptz not null default now()
);

create index vacancy_versions_vacancy_id_idx on public.vacancy_versions (vacancy_id);

alter table public.vacancy_versions enable row level security;

revoke all on public.vacancy_versions from public;
revoke all on public.vacancy_versions from anon;
revoke all on public.vacancy_versions from authenticated;

-- Internal evidence/audit trail, not shown on the candidate Opportunities
-- screen (PRD §18.2 lists "Evidence link", not raw provider payloads) —
-- worker-only, no candidate SELECT. INSERT only: "immutable" per §21.2
-- means no UPDATE/DELETE grant, not even for service_role.
grant select, insert on public.vacancy_versions to service_role;
