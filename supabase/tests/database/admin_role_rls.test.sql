begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

-- R8.1: 'admin' becomes a second valid user_roles.role value, additive to
-- the R3.1 moderator-only CHECK constraint. No RLS/grant changes — every
-- admin route in R8.1 reads through the service-role client in Express
-- (requireAdmin.ts, mirroring requireModerator.ts's own "no request-scoped
-- RLS client" pattern), so no is_admin() SQL helper is added here.

insert into auth.users (id, email) values
  ('33333333-5555-1111-1111-111111111111', 'admin-a@test.local');

-- 1. 'admin' is now accepted by the CHECK constraint
select lives_ok(
  $$insert into user_roles (user_id, role) values ('33333333-5555-1111-1111-111111111111', 'admin')$$,
  'user_roles CHECK constraint accepts the new admin role'
);

-- 2. 'moderator' still works — regression check against the R3.1 constraint
select lives_ok(
  $$insert into user_roles (user_id, role) values ('33333333-5555-1111-1111-111111111111', 'moderator')$$,
  'user_roles CHECK constraint still accepts moderator, unaffected by the admin addition'
);

-- 3. An arbitrary invalid role is still rejected
select throws_ok(
  $$insert into user_roles (user_id, role) values ('33333333-5555-1111-1111-111111111111', 'superuser')$$,
  '23514',
  null,
  'user_roles CHECK constraint still rejects roles other than moderator/admin'
);

-- 4. No grant regression from this migration — still service_role only.
set local role authenticated;
select throws_ok(
  $$select role from user_roles$$,
  '42501',
  null,
  'authenticated is still denied all access to user_roles'
);
reset role;

select * from finish();
rollback;
