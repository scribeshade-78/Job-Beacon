-- Task H4: audit, security events and the §21.2 immutability rules.
--
-- NAMING, AND WHY IT DIFFERS FROM THE BRIEF. The brief asked for "audit_logs ...
-- as defined in PRD v3 §21.1". §21.1 does not define audit_logs. Its Audit domain
-- row reads:
--
--   "Audit  audit_events, model_executions, policy_versions, security_events"
--
-- audit_logs is the name used by JobBeacon_EndToEnd_extracted.txt, a document
-- describing a DIFFERENT codebase (see Task G). Since the instruction was to
-- follow §21.1, the PRD's own names are used: audit_events and security_events.
-- Flagged rather than silently reconciled.
--
-- model_executions and policy_versions are NOT built here. §24.3 wants "model,
-- prompt and schema version" recorded, and §21.2 wants trust decisions to
-- reference policy versions — both real requirements, both larger than this
-- task, and neither is what "make system actions auditable" needs to start.
--
-- §21.2's "Moderation decisions cannot be deleted; corrections create new
-- versions" is enforced here as a trigger, because a rule that lives only in a
-- document is a rule that a retry loop can violate.

-- ---------------------------------------------------------------------------
-- 1. audit_events.
--
-- FIELDS ARE THE UNION OF THE TWO DOCUMENTS THAT DEFINE THEM. PRD v3 §21.1
-- names the table; the Response Intelligence PRD §15 defines the record:
-- "actor, timestamp, entity, previous/new value, reason, correlation ID".
-- Both are honoured, and nothing is added beyond them.
--
-- PREVIOUS VALUES ARE STORED, NOT INFERRED. "corrections create new versions"
-- (§21.2) is only checkable if the prior state survives somewhere, and a row
-- that says "decision changed" without saying what it changed FROM cannot
-- answer the only question anyone asks an audit log.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),

  /** NULL for system-initiated actions, which have no human actor. */
  actor_id uuid,
  actor_role text not null,
  /** Where the actor's request came from, when there was one. */
  actor_ip text,

  /** Dotted verb, e.g. 'moderation.decision.recorded'. Stable enough to filter on. */
  action text not null,
  entity_type text not null,
  /** text, not uuid: some audited entities are keyed by a source code or a slug. */
  entity_id text,

  /** One human-readable line, so a reviewer does not have to diff jsonb to understand the row. */
  summary text not null,
  previous_values jsonb,
  new_values jsonb,
  reason text,

  /** Ties several events to one request or one job run. */
  correlation_id uuid,

  created_at timestamptz not null default now(),

  check (actor_role in ('candidate', 'moderator', 'admin', 'system')),
  check (length(trim(action)) > 0),
  check (length(trim(entity_type)) > 0),
  check (length(trim(summary)) > 0)
);

create index audit_events_occurred_idx on public.audit_events (occurred_at desc);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id, occurred_at desc);
create index audit_events_action_idx on public.audit_events (action, occurred_at desc);
create index audit_events_actor_idx on public.audit_events (actor_id, occurred_at desc);

comment on table public.audit_events is
  'Append-only record of security- and trust-relevant actions (PRD v3 §21.1 Audit domain; fields per RI PRD §15 "AuditEvent"). service_role can INSERT and SELECT and nothing else, so no code path can rewrite history.';

-- ---------------------------------------------------------------------------
-- 2. security_events.
--
-- §21.1 names it; RI PRD §10.3 is what fills it. §10.3 requires that email, JD
-- and web-page text be treated "as data, never trusted instructions", that
-- active HTML and tracking pixels be stripped, and that the model be unable to
-- act on embedded instructions. Those defences are only worth having if a
-- refusal is VISIBLE, so every detection writes here. A sanitizer that silently
-- rewrites text is indistinguishable from a sanitizer that is not running.
-- ---------------------------------------------------------------------------
create table public.security_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),

  event_type text not null,
  severity text not null,
  /** Which untrusted surface it came from — RI PRD §10.3 names email, JD, attachment and web pages. */
  source text not null,

  /** The row it was found in, when there is one: a message id, a vacancy id. */
  subject_id uuid,
  detail jsonb,

  created_at timestamptz not null default now(),

  check (severity in ('low', 'medium', 'high')),
  check (source in ('jd_text', 'email_body', 'email_html', 'attachment', 'web_page', 'other')),
  check (length(trim(event_type)) > 0)
);

create index security_events_occurred_idx on public.security_events (occurred_at desc);
create index security_events_type_idx on public.security_events (event_type, occurred_at desc);

comment on table public.security_events is
  'Detections from the untrusted-content defences required by RI PRD §10.3. Append-only. Written to rather than logged, so an injection attempt is a queryable fact rather than something that scrolled past in a container log.';

-- ---------------------------------------------------------------------------
-- 3. Append-only, enforced rather than assumed.
--
-- The grant is the first half: service_role gets INSERT and SELECT only, so no
-- ordinary write path can remove or rewrite an audit row. The trigger is the
-- second half, and it exists because a grant is not enough on its own — the
-- table owner and any future SECURITY DEFINER function bypass grants entirely,
-- and "nobody would do that" is exactly the assumption an audit log cannot
-- afford. Corrections are new rows; there is no supported way to erase one.
-- ---------------------------------------------------------------------------
create function public.audit_events_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_events_no_update
  before update or delete on public.audit_events
  for each statement
  execute function public.audit_events_are_append_only();

create function public.security_events_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'security_events is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger security_events_no_update
  before update or delete on public.security_events
  for each statement
  execute function public.security_events_are_append_only();

alter table public.audit_events enable row level security;
alter table public.security_events enable row level security;

revoke all on public.audit_events from public, anon, authenticated;
revoke all on public.security_events from public, anon, authenticated;

-- SELECT + INSERT only. No UPDATE, no DELETE, for anyone.
grant select, insert on public.audit_events to service_role;
grant select, insert on public.security_events to service_role;

revoke all on function public.audit_events_are_append_only() from public, anon, authenticated;
revoke all on function public.security_events_are_append_only() from public, anon, authenticated;

-- No policy is created for either table. There is no candidate-facing view of
-- the system audit trail, and the admin console reads it through an
-- admin-gated Express route on the service-role client — the same shape
-- ats_credentials already uses. An authenticated grant would be a second,
-- undocumented read path to the same rows.

-- ---------------------------------------------------------------------------
-- 4. §21.2 "Moderation decisions cannot be deleted; corrections create new
-- versions."
--
-- moderation_decisions already has a policy_version column, which is how a
-- correction is MEANT to be expressed — insert a new decision with a new
-- version. Nothing stopped a retry loop, a test cleanup or a well-meaning
-- operator from deleting the old one, which would leave the newest decision
-- standing with no record of what it replaced.
--
-- Only DELETE is blocked. UPDATE is left alone deliberately: the existing
-- enforce_appeal_reviewer_separation trigger and any future metadata backfill
-- need it, and the PRD's constraint is about deletion and versioning, not about
-- making the row write-once.
-- ---------------------------------------------------------------------------
create function public.moderation_decisions_cannot_be_deleted()
returns trigger
language plpgsql
as $$
begin
  raise exception 'moderation_decisions cannot be deleted (PRD v3 §21.2); record a correction as a new decision with a new policy_version'
    using errcode = 'restrict_violation';
end;
$$;

create trigger moderation_decisions_no_delete
  before delete on public.moderation_decisions
  for each statement
  execute function public.moderation_decisions_cannot_be_deleted();

revoke all on function public.moderation_decisions_cannot_be_deleted() from public, anon, authenticated;
