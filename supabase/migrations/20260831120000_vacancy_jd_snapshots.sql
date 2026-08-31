-- Response Intelligence Phase 2.1 — JD Preservation (Opportunity
-- Intelligence PRD §11.1: "Store canonical URL and capture date. Store
-- cleaned JD text with section boundaries. Store permitted screenshot or
-- HTML snapshot when available. Retain new versions when a posting is
-- edited.").
--
-- vacancy_versions (20260813205337) already stores the immutable, verbatim
-- provider payload, one row per changed fetch. This table stores the
-- *cleaned* JD derived from one such version: plain text + detected
-- section boundaries, produced by a deterministic per-adapter extractor
-- (server/opportunities/jdExtraction.ts). Tying each snapshot to a
-- vacancy_version_id gives "retain new versions when a posting is edited"
-- for free — a new vacancy_versions row yields a new jd_snapshot.
--
-- No screenshot capture in v1 — §11.1's "permitted screenshot" is
-- deferred; html_snapshot holds the raw provider HTML when the adapter
-- has one (Greenhouse content, Lever description), NULL otherwise
-- (Adzuna/USAJOBS return structured fields, no HTML document).
create table public.vacancy_jd_snapshots (
  id uuid primary key default gen_random_uuid(),
  vacancy_id uuid not null references public.vacancies (id) on delete cascade,
  vacancy_version_id uuid not null references public.vacancy_versions (id) on delete cascade,

  canonical_url text not null,
  captured_at timestamptz not null default now(),

  -- §11.1 "cleaned JD text with section boundaries"
  clean_text text not null,
  sections jsonb not null,             -- [{ heading: text | null, body: text }]
  html_snapshot text,                  -- raw provider HTML when available; NULL otherwise

  source_code text not null,           -- which adapter mapping produced this
  extractor_version text not null,     -- bump when jdExtraction.ts mapping logic changes

  created_at timestamptz not null default now(),

  -- One snapshot per raw version; the worker upserts on re-run (a
  -- prompt/extractor bump re-extracts the same version in place rather
  -- than accumulating duplicates), same idempotency shape as
  -- response_classifications' unique (message_id).
  unique (vacancy_version_id)
);

create index vacancy_jd_snapshots_vacancy_id_idx on public.vacancy_jd_snapshots (vacancy_id);

alter table public.vacancy_jd_snapshots enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.vacancy_jd_snapshots from public;
revoke all on public.vacancy_jd_snapshots from anon;
revoke all on public.vacancy_jd_snapshots from authenticated;

-- clean_text is public employer-posting content (the same information a
-- candidate sees by opening the vacancy's canonical_url) — no candidate
-- scoping needed, mirrors the broad authenticated SELECT on vacancies
-- itself. Writes are worker-only.
grant select on public.vacancy_jd_snapshots to authenticated;
grant select, insert, update, delete on public.vacancy_jd_snapshots to service_role;

create policy "vacancy_jd_snapshots_select_all"
  on public.vacancy_jd_snapshots
  for select
  to authenticated
  using (true);
