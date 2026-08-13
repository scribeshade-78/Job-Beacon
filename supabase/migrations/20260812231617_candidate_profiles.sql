create table public.candidate_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.candidate_profiles enable row level security;

-- Explicit and defensive: never rely on this project's default privileges.
-- Supabase's base template pre-grants TRUNCATE/REFERENCES/TRIGGER (among
-- others) to authenticated on new public-schema tables via ALTER DEFAULT
-- PRIVILEGES — confirmed by inspecting information_schema.role_table_grants
-- on the local stack. TRUNCATE bypasses RLS entirely (not row-scoped), so
-- revoking ALL first and granting back only what this slice needs is not
-- optional hardening — it is required to actually reach select+insert-only.
revoke all on public.candidate_profiles from public;
revoke all on public.candidate_profiles from anon;
revoke all on public.candidate_profiles from authenticated;

grant select, insert on public.candidate_profiles to authenticated;

create policy "candidate_profiles_select_own"
  on public.candidate_profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "candidate_profiles_insert_own"
  on public.candidate_profiles
  for insert
  to authenticated
  with check ((select auth.uid()) = id);
