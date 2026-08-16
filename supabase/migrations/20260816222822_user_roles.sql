-- Moderator role foundation (PRD §19 "Moderator and Admin Experience").
-- Database-native RBAC: a user_roles table plus a SECURITY DEFINER helper
-- function RLS policies call to check the caller's role. Only 'moderator'
-- is a valid role today — no other role (e.g. admin) is scoped by any R3
-- mini-phase yet; additive if/when one is needed.
create table public.user_roles (
  user_id uuid not null references auth.users (id),
  role text not null check (role in ('moderator')),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

alter table public.user_roles enable row level security;

-- Service-role only: role assignment is a privileged, server-side-only
-- operation — "hiding UI controls is not authorization" holds here too,
-- so enforcement lives in the grant, not in application code. No
-- candidate-facing access at all, not even to a user's own row —
-- is_moderator() below is SECURITY DEFINER and doesn't need a policy here
-- to do its job.
revoke all on public.user_roles from public;
revoke all on public.user_roles from anon;
revoke all on public.user_roles from authenticated;

grant select, insert, update, delete on public.user_roles to service_role;

-- SECURITY DEFINER so RLS on user_roles (which grants authenticated
-- nothing at all) doesn't block this check — runs with the function
-- owner's privileges, the same pattern auth.uid()/auth.role() already use
-- in this project's local Supabase schema.
create or replace function public.is_moderator()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'moderator'
  );
$$;

revoke all on function public.is_moderator() from public;
grant execute on function public.is_moderator() to authenticated;
