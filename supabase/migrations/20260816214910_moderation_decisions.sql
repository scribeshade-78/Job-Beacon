-- Immutable moderator decisions (PRD §13.2 steps 28 & 32, §19.1, §21.2
-- "moderation decisions cannot be deleted; corrections create new
-- versions"). One case can have multiple decisions over time (initial
-- review, then a later appeal decision) — append-only, never updated.
--
-- reviewer_id references auth.users directly, the same way
-- candidate_profiles.id does for candidates — this only needs a real user
-- identity to exist, not a moderator role/permission system, which is a
-- separate authorization concern for whichever mini-phase builds the
-- moderator console (R3.6). Tracking who reviewed what is required now
-- regardless, for §13.4's "moderator cannot review their own prior
-- decision on appeal" and "reviewer separation enforced" (§13.2 step 31).
create table public.moderation_decisions (
  id uuid primary key default gen_random_uuid(),
  moderation_case_id uuid not null references public.moderation_cases (id),
  reviewer_id uuid not null references auth.users (id),

  -- §19.1 moderator dashboard actions: "Clear/flag/block/request-info/escalate".
  decision text not null check (decision in (
    'cleared',
    'flagged',
    'blocked',
    'request_info',
    'escalated'
  )),

  -- §13.2 step 28 "Decision recorded with policy version and rationale";
  -- §19.1 "Decision rationale required".
  rationale text not null,
  policy_version text not null,

  created_at timestamptz not null default now()
);

create index moderation_decisions_moderation_case_id_idx on public.moderation_decisions (moderation_case_id, created_at desc);
create index moderation_decisions_reviewer_id_idx on public.moderation_decisions (reviewer_id);

alter table public.moderation_decisions enable row level security;

-- Service-role only for now, same reasoning as moderation_cases.
revoke all on public.moderation_decisions from public;
revoke all on public.moderation_decisions from anon;
revoke all on public.moderation_decisions from authenticated;

grant select, insert, update, delete on public.moderation_decisions to service_role;
