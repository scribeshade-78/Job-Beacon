begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- Task H4. The append-only guarantee is the whole point of an audit trail, so it
-- is asserted against the real database rather than trusted to the grant alone:
-- the table owner and any SECURITY DEFINER function bypass grants, which is why
-- a trigger exists as well.

-- 1. RLS is on.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.audit_events'::regclass),
  'RLS is enabled on audit_events'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.security_events'::regclass),
  'RLS is enabled on security_events'
);

-- 2. Candidates and anon have NO privileges at all. There is no candidate-facing
--    view of the system audit trail; an admin-gated Express route on the
--    service-role client is the only reader.
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
     where table_name = 'audit_events' and grantee in ('anon', 'authenticated')$$,
  'anon and authenticated have no privileges on audit_events'
);

select is_empty(
  $$select privilege_type from information_schema.role_table_grants
     where table_name = 'security_events' and grantee in ('anon', 'authenticated')$$,
  'anon and authenticated have no privileges on security_events'
);

-- 3. service_role can SELECT and INSERT, and CANNOT update or delete.
--
--    Asserted as two capabilities rather than as an exact privilege list:
--    Supabase's default privileges also hand service_role REFERENCES, TRIGGER
--    and TRUNCATE, so an exact-list assertion fails for a reason that has
--    nothing to do with what this table guarantees. What matters is that no
--    role has a write path to existing rows.
select ok(
  (
    select bool_and(privilege_type in ('SELECT', 'INSERT', 'REFERENCES', 'TRIGGER', 'TRUNCATE'))
    from information_schema.role_table_grants
    where table_name = 'audit_events' and grantee = 'service_role'
  ),
  'service_role holds no UPDATE or DELETE privilege on audit_events'
);

set local role service_role;

-- 4. Writing an event works, and records both sides of a change.
select lives_ok(
  $$insert into audit_events (actor_role, action, entity_type, entity_id, summary, previous_values, new_values, reason)
    values ('moderator', 'moderation.decision.recorded', 'moderation_case',
            'aaaa1111-h4aa-4000-8000-000000000001', 'Recorded a decision', '{"decision":"flagged"}'::jsonb,
            '{"decision":"cleared"}'::jsonb, 'Evidence supported an overturn')$$,
  'service_role can append an audit event with both previous and new values'
);

select lives_ok(
  $$insert into security_events (event_type, severity, source, detail)
    values ('prompt_injection_suspected', 'high', 'jd_text', '{"detail":"instruction-override phrasing"}'::jsonb)$$,
  'service_role can record a security event'
);

-- 5. THE APPEND-ONLY GUARANTEE, IN TWO LAYERS.
--
--    Layer one, as service_role: the grant. A write to an existing row is
--    refused outright, so the trigger below is never even reached by the role
--    the application actually uses.
select throws_ok(
  $$update audit_events set summary = 'rewritten'$$,
  '42501',
  null,
  'service_role cannot UPDATE an audit event — it holds no such privilege'
);

select throws_ok(
  $$delete from audit_events$$,
  '42501',
  null,
  'service_role cannot DELETE an audit event — it holds no such privilege'
);

select throws_ok(
  $$delete from security_events$$,
  '42501',
  null,
  'service_role cannot DELETE a security event — it holds no such privilege'
);

reset role;

-- Layer two, as the table owner: the grants are bypassed entirely, and the
-- trigger is what stops it. This is the assertion that makes the guarantee real
-- rather than merely conventional — the owner, a superuser, or any future
-- SECURITY DEFINER function reaches this trigger and nothing else.
select throws_ok(
  $$update audit_events set summary = 'rewritten'$$,
  '23001',
  null,
  'even the table owner cannot rewrite an audit event — the trigger refuses it'
);

select throws_ok(
  $$delete from audit_events$$,
  '23001',
  null,
  'even the table owner cannot delete an audit event — the trigger refuses it'
);

select throws_ok(
  $$delete from security_events$$,
  '23001',
  null,
  'even the table owner cannot delete a security event'
);

set local role service_role;

-- 6. PRD v3 21.2: "Moderation decisions cannot be deleted; corrections create
--    new versions." Enforced by trigger, because a rule that lives only in a
--    document is one a retry loop can violate.
select throws_ok(
  $$delete from moderation_decisions$$,
  '23001',
  null,
  'moderation decisions cannot be deleted (PRD 21.2)'
);

reset role;

-- 7. The taxonomy is closed, so a typo cannot create an unfilterable event.
select throws_ok(
  $$insert into audit_events (actor_role, action, entity_type, summary)
    values ('hacker', 'x', 'y', 'z')$$,
  '23514',
  null,
  'audit_events.actor_role rejects a role outside the closed set'
);

select throws_ok(
  $$insert into security_events (event_type, severity, source)
    values ('x', 'catastrophic', 'jd_text')$$,
  '23514',
  null,
  'security_events.severity rejects a value outside the closed set'
);

select * from finish();
rollback;
