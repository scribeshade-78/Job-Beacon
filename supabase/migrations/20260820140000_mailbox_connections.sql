-- Mailbox connection foundation (R6.1; PRD §21.1 Responses domain,
-- §23 "Mailbox workers: OAuth ingestion, classification and application
-- matching", §28 "R6 — Mailbox and responses: Gmail/Outlook OAuth,
-- response classification and interviews. Exit gate: Security and
-- matching accuracy."). Schema and RLS only — no OAuth flow, no
-- classification, no message ingestion exists anywhere in this
-- repository yet. Real Gmail/Outlook OAuth requires registering an
-- actual app with Google Cloud Console / Microsoft Entra (a verified
-- consent screen, a real client ID/secret, and for Gmail's
-- gmail.readonly-class scopes, Google's own restricted-scope security
-- assessment) — an external, account-level action, not something a
-- migration can front-run.
--
-- No raw OAuth token columns exist here, deliberately: PRD §23's own
-- System Architecture table requires "Secret manager — Source and
-- employer credentials; no secrets in browser or [database]." Tokens
-- belong in a secret manager (not chosen or integrated yet); this table
-- holds only a secret_manager_key — an opaque reference to wherever the
-- real token eventually lives — plus connection metadata and an audit
-- trail of granted scopes.
--
-- provider is a real, PRD-named two-value enumeration ("Gmail/Outlook
-- OAuth", stated verbatim twice in §8 and §28) — unlike role_name/
-- fact_type/registration_status elsewhere in this repository, this one
-- IS enumerated by the source document, so a CHECK constraint is
-- warranted rather than free text.
--
-- Candidate-facing SELECT only, no candidate INSERT/UPDATE grant: the
-- actual "connect" action (once built) completes via a server-side
-- OAuth callback under service_role, the same "system-generated,
-- worker-written" precedent as application_plans — not a direct
-- candidate write to an RLS-protected table.
create table public.mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidate_profiles (id) on delete cascade,

  provider text not null check (provider in ('gmail', 'outlook')),
  status text not null default 'pending' check (status in ('pending', 'connected', 'revoked', 'error')),

  secret_manager_key text,
  granted_scopes text[],

  connected_at timestamptz,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index mailbox_connections_candidate_id_idx on public.mailbox_connections (candidate_id);

alter table public.mailbox_connections enable row level security;

-- Same defense-in-depth reasoning as every prior migration: revoke
-- everything Supabase's base template pre-grants (TRUNCATE bypasses RLS
-- entirely), then grant back only what this slice needs.
revoke all on public.mailbox_connections from public;
revoke all on public.mailbox_connections from anon;
revoke all on public.mailbox_connections from authenticated;

grant select on public.mailbox_connections to authenticated;
grant select, insert, update, delete on public.mailbox_connections to service_role;

create policy "mailbox_connections_select_own"
  on public.mailbox_connections
  for select
  to authenticated
  using ((select auth.uid()) = candidate_id);
