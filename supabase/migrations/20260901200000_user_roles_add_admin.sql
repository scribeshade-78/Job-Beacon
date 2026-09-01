-- R8.1 Admin Operations Panel (PRD §19 admin/moderator experience). Adds
-- 'admin' as a second valid user_roles.role value, additive to the R3.1
-- moderator-only CHECK — no existing rows are touched, 'moderator' stays
-- valid unchanged, and no grants change (still service_role only).
--
-- No is_admin() SQL function is added alongside this, unlike is_moderator()
-- in the R3.1 migration: every R8.1 admin route reads through the
-- service-role client in Express (server/requireAdmin.ts, same "no
-- request-scoped RLS client" pattern requireModerator.ts already uses), and
-- no RLS policy in this phase checks for the admin role. Add one additively
-- if a future phase puts an admin-gated policy on a table.
alter table public.user_roles
  drop constraint user_roles_role_check;

alter table public.user_roles
  add constraint user_roles_role_check check (role in ('moderator', 'admin'));
