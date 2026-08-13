-- Ingestion run log (PRD §21.1 Sources domain: source_health_events;
-- feeds §26.4's "Source fetch success and latency" operational metric).
-- Also satisfies the jobbeacon-development skill's requirement that every
-- job type define "Failed-job visibility and manual retry" and
-- "Structured logs without sensitive payloads" — this is that visibility,
-- not a dashboard, just an audit log.
create table public.source_health_events (
  id uuid primary key default gen_random_uuid(),
  source_code text not null references public.source_policies (source_code),
  vacancy_source_id uuid references public.vacancy_sources (id) on delete set null,
  status text not null check (status in ('success', 'error')),
  vacancies_fetched integer not null default 0,
  error_message text,
  duration_ms integer,
  run_at timestamptz not null default now()
);

create index source_health_events_source_code_idx on public.source_health_events (source_code, run_at desc);

alter table public.source_health_events enable row level security;

revoke all on public.source_health_events from public;
revoke all on public.source_health_events from anon;
revoke all on public.source_health_events from authenticated;

-- Internal operational data (PRD §19.2 "Source health and error metrics"
-- is Moderator/Admin experience, not candidate-facing) — worker-only.
grant select, insert on public.source_health_events to service_role;
