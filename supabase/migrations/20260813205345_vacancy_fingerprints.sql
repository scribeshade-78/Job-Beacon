-- Dedup rule 3 (§11.3): "Company + normalized title + location +
-- publish-window fingerprint". Purely an internal dedup mechanism — no
-- candidate-facing purpose, so no SELECT grant unlike the tables above.
create table public.vacancy_fingerprints (
  vacancy_id uuid primary key references public.vacancies (id) on delete cascade,
  fingerprint text not null,
  created_at timestamptz not null default now()
);

create index vacancy_fingerprints_fingerprint_idx on public.vacancy_fingerprints (fingerprint);

alter table public.vacancy_fingerprints enable row level security;

revoke all on public.vacancy_fingerprints from public;
revoke all on public.vacancy_fingerprints from anon;
revoke all on public.vacancy_fingerprints from authenticated;

grant select, insert, update, delete on public.vacancy_fingerprints to service_role;
