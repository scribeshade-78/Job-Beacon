-- Opportunity Intelligence Phase 2.3c — the candidate_opportunities view.
--
-- The assertion that matters most here is #2: security_invoker must be ON.
-- If it silently reverted to the default, the view would execute as its
-- owner, RLS on fit_analyses / application_plans would not apply, and every
-- candidate would read every other candidate's fit analysis. That failure
-- is invisible from the view definition alone, so it is asserted against
-- pg_class.reloptions directly rather than inferred from behaviour.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Fixture (as postgres).
insert into auth.users (id, email) values
  ('aaaaaaaa-9241-1111-1111-111111111111', 'view-a@test.local'),
  ('bbbbbbbb-9241-1111-1111-111111111111', 'view-b@test.local');
insert into candidate_profiles (id) values
  ('aaaaaaaa-9241-1111-1111-111111111111'),
  ('bbbbbbbb-9241-1111-1111-111111111111');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('cccccccc-9241-1111-1111-111111111111', 'greenhouse', 'acme');
insert into companies (id, displayed_name, domain)
values ('c0c0c0c0-9241-1111-1111-111111111111', 'Acme Corp', 'acme.com');

insert into vacancies (
  id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url,
  raw_title, company_id, trust_status, status
)
values
  -- visible: VERIFIED + active, with a company
  ('d1111111-9241-1111-1111-111111111111', 'greenhouse', 'cccccccc-9241-1111-1111-111111111111', 'gh-v1',
   'https://boards.greenhouse.io/acme/jobs/1', 'Senior Platform Engineer',
   'c0c0c0c0-9241-1111-1111-111111111111', 'VERIFIED', 'active'),
  -- visible: VERIFIED_INCOMPLETE + active, deliberately NO company
  ('d2222222-9241-1111-1111-111111111111', 'greenhouse', 'cccccccc-9241-1111-1111-111111111111', 'gh-v2',
   'https://boards.greenhouse.io/acme/jobs/2', 'Backend Engineer',
   null, 'VERIFIED_INCOMPLETE', 'active'),
  -- excluded: not a verified trust state
  ('d3333333-9241-1111-1111-111111111111', 'greenhouse', 'cccccccc-9241-1111-1111-111111111111', 'gh-v3',
   'https://boards.greenhouse.io/acme/jobs/3', 'Flagged Role',
   'c0c0c0c0-9241-1111-1111-111111111111', 'FLAGGED', 'active'),
  -- excluded: verified but no longer live
  ('d4444444-9241-1111-1111-111111111111', 'greenhouse', 'cccccccc-9241-1111-1111-111111111111', 'gh-v4',
   'https://boards.greenhouse.io/acme/jobs/4', 'Expired Role',
   'c0c0c0c0-9241-1111-1111-111111111111', 'VERIFIED', 'expired');

-- Both candidates have a fit analysis on the SAME vacancy, with different
-- scores — this is what proves the per-candidate scoping.
set local role service_role;
insert into fit_analyses (
  candidate_id, vacancy_id, jd_text_available, model_version, prompt_version,
  priority_score, priority_uncapped_score, priority_score_version
)
values
  ('aaaaaaaa-9241-1111-1111-111111111111', 'd1111111-9241-1111-1111-111111111111', true, 'm', 'p',
   88, 88, 'priority-v3'),
  ('bbbbbbbb-9241-1111-1111-111111111111', 'd1111111-9241-1111-1111-111111111111', true, 'm', 'p',
   11, 11, 'priority-v3');

insert into application_plans (id, candidate_id, vacancy_id, gate_results)
values ('ababab00-9241-1111-1111-111111111111', 'aaaaaaaa-9241-1111-1111-111111111111',
        'd1111111-9241-1111-1111-111111111111', '{"eligible": true}'::jsonb);

-- Two attempts on the same plan: the view's lateral must surface the most
-- recent one and must NOT fan the vacancy out into two rows.
insert into application_attempts (id, application_plan_id, status, created_at)
values
  ('aa111111-9241-1111-1111-111111111111', 'ababab00-9241-1111-1111-111111111111',
   'failed', now() - interval '2 days'),
  ('aa222222-9241-1111-1111-111111111111', 'ababab00-9241-1111-1111-111111111111',
   'action_required', now());
reset role;

-- 1. the view exists
select has_view('public', 'candidate_opportunities', 'candidate_opportunities view exists');

-- 2. THE critical assertion: security_invoker is on. Parsed with
--    pg_options_to_table and cast to boolean rather than string-matched:
--    Postgres stores the reloption verbatim, so "on", "true" and "1" are
--    all valid spellings of the same setting and a textual comparison
--    would fail on a harmless rewrite of the migration.
select ok(
  (
    select coalesce(
      (
        select opt.option_value::boolean
        from pg_options_to_table(c.reloptions) opt
        where opt.option_name = 'security_invoker'
      ),
      false
    )
    from pg_class c
    where c.oid = 'public.candidate_opportunities'::regclass
  ),
  'candidate_opportunities has security_invoker enabled (without it, RLS would not apply)'
);

-- 3. authenticated has exactly SELECT
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'candidate_opportunities' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on candidate_opportunities'
);

-- 4. anon has nothing
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'candidate_opportunities' and grantee = 'anon'$$,
  'anon has no privileges on candidate_opportunities'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-9241-1111-1111-111111111111"}';

-- 5. only verified + active vacancies appear, one row each (no join fan-out).
--    Scoped to this file's four fixture vacancies: an unscoped count(*) also
--    swept in every other visible vacancy in the database, so it only ever
--    equalled 2 on an empty one. All four ids are listed rather than just the
--    two expected ones, which keeps the "excluded ones stay out" half of the
--    assertion here as well.
select is(
  (select count(*)::int from candidate_opportunities
     where id in ('d1111111-9241-1111-1111-111111111111',
                  'd2222222-9241-1111-1111-111111111111',
                  'd3333333-9241-1111-1111-111111111111',
                  'd4444444-9241-1111-1111-111111111111')),
  2,
  'only the VERIFIED and VERIFIED_INCOMPLETE active vacancies appear, one row each'
);

-- 6. the FLAGGED and expired ones are excluded by name
select is_empty(
  $$select id from candidate_opportunities
      where id in ('d3333333-9241-1111-1111-111111111111',
                   'd4444444-9241-1111-1111-111111111111')$$,
  'FLAGGED and expired vacancies are excluded from the view'
);

-- 7. candidate A sees THEIR OWN priority score
select is(
  (select priority_score from candidate_opportunities
     where id = 'd1111111-9241-1111-1111-111111111111'),
  88,
  'candidate A sees their own priority_score through the view'
);

-- 8. and never candidate B's, on the same vacancy
select is_empty(
  $$select id from candidate_opportunities where priority_score = 11$$,
  'candidate A cannot see candidate B''s fit analysis through the view'
);

-- 9. the company columns are joined through
select is(
  (select company_name from candidate_opportunities
     where id = 'd1111111-9241-1111-1111-111111111111'),
  'Acme Corp',
  'company_name is joined into the view'
);

-- 10. a vacancy with no company still appears (LEFT JOIN, not INNER)
select is(
  (select company_name is null from candidate_opportunities
     where id = 'd2222222-9241-1111-1111-111111111111'),
  true,
  'a vacancy with no company row still appears, with a null company_name'
);

-- 11. the candidate's own plan + LATEST attempt are exposed as scalars,
--     without the two attempts fanning the vacancy into two rows (that a
--     single row came back is already asserted by #5).
select is(
  (select plan_gate_results->>'eligible' || '/' || attempt_status
     from candidate_opportunities
     where id = 'd1111111-9241-1111-1111-111111111111'),
  'true/action_required',
  'the plan gate and the most recent attempt status are joined as scalars'
);
reset role;

-- 12. candidate B sees their own score on the same vacancy — the mirror of #7,
--     which rules out "A simply sees the lowest/first row".
set local role authenticated;
set local request.jwt.claims to '{"sub":"bbbbbbbb-9241-1111-1111-111111111111"}';
select is(
  (select priority_score from candidate_opportunities
     where id = 'd1111111-9241-1111-1111-111111111111'),
  11,
  'candidate B sees their own priority_score on the same vacancy'
);
reset role;

select * from finish();
rollback;
