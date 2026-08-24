begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-9003-1111-1111-111111111111', 'candidate-a@test.local'),
  ('22222222-9003-1111-1111-111111111111', 'candidate-b@test.local');

insert into candidate_profiles (id) values
  ('11111111-9003-1111-1111-111111111111'),
  ('22222222-9003-1111-1111-111111111111');

insert into companies (id, displayed_name, domain)
values ('cccccccc-9003-1111-1111-111111111111', 'Reviewco', 'reviewco.example');

-- =========================================================================
-- Section A: company_reviews base table
-- =========================================================================

-- 1. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.company_reviews'::regclass),
  'RLS is enabled on company_reviews'
);

-- 2. authenticated has exactly SELECT and INSERT (no UPDATE/DELETE — reviews aren't editable this phase)
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'company_reviews' and grantee = 'authenticated'
  ) = array['INSERT', 'SELECT'],
  'authenticated has exactly SELECT and INSERT on company_reviews'
);

-- 3. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_reviews' and grantee = 'anon'$$,
  'anon has no privileges on company_reviews'
);

-- as Candidate A
set local role authenticated;
set local request.jwt.claim.sub = '11111111-9003-1111-1111-111111111111';

-- 4. Candidate A can insert their own review
select lives_ok(
  $$insert into company_reviews (id, company_id, reviewer_id, work_life_balance, compensation, management_and_culture, career_growth, review_text)
    values ('dddddddd-9003-1111-1111-111111111111', 'cccccccc-9003-1111-1111-111111111111', '11111111-9003-1111-1111-111111111111', 4, 3, 5, 4, 'Solid team.')$$,
  'Candidate A can insert their own company_reviews row'
);

-- 5. An out-of-range rating is rejected by the check constraint
select throws_ok(
  $$insert into company_reviews (company_id, reviewer_id, work_life_balance, compensation, management_and_culture, career_growth)
    values ('cccccccc-9003-1111-1111-111111111111', '11111111-9003-1111-1111-111111111111', 6, 3, 5, 4)$$,
  '23514',
  null,
  'A rating outside 1-5 is rejected by the check constraint'
);

-- 6. A second review for the same company by the same reviewer is rejected (permanent unique constraint)
select throws_ok(
  $$insert into company_reviews (company_id, reviewer_id, work_life_balance, compensation, management_and_culture, career_growth)
    values ('cccccccc-9003-1111-1111-111111111111', '11111111-9003-1111-1111-111111111111', 3, 3, 3, 3)$$,
  '23505',
  null,
  'A duplicate (company_id, reviewer_id) review is rejected by the unique constraint'
);

-- 7. Candidate A can see their own (still-pending) review, including their own reviewer_id
select results_eq(
  $$select reviewer_id from company_reviews where id = 'dddddddd-9003-1111-1111-111111111111'$$,
  $$values ('11111111-9003-1111-1111-111111111111'::uuid)$$,
  'Candidate A can see their own review row via the base table, including reviewer_id'
);

-- 8. Candidate B cannot see Candidate A's pending review via the base table
set local request.jwt.claim.sub = '22222222-9003-1111-1111-111111111111';
select is_empty(
  $$select id from company_reviews where id = 'dddddddd-9003-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s pending review via the base table'
);
reset role;

-- 9. service_role verifies Candidate A's review
set local role service_role;
select lives_ok(
  $$update company_reviews set verification_status = 'verified' where id = 'dddddddd-9003-1111-1111-111111111111'$$,
  'service_role can verify a review'
);
reset role;

-- 10. Candidate B still cannot see Candidate A's review via the base table, even now that it's verified —
-- the anonymity boundary is that cross-candidate reads never touch the base table at all, only the view below.
set local role authenticated;
set local request.jwt.claim.sub = '22222222-9003-1111-1111-111111111111';
select is_empty(
  $$select id from company_reviews where id = 'dddddddd-9003-1111-1111-111111111111'$$,
  'Candidate B cannot see Candidate A''s verified review via the base table either'
);

-- =========================================================================
-- Section B: company_reviews_public view (the actual cross-candidate read surface)
-- =========================================================================

-- 11. Candidate B CAN see Candidate A's verified review via the public view
select results_eq(
  $$select review_text from company_reviews_public where id = 'dddddddd-9003-1111-1111-111111111111'$$,
  $$values ('Solid team.'::text)$$,
  'Candidate B can see Candidate A''s verified review via company_reviews_public'
);

-- 12. company_reviews_public has no reviewer_id column at all — true anonymity, not just an unselected column
select throws_ok(
  $$select reviewer_id from company_reviews_public$$,
  '42703',
  null,
  'company_reviews_public has no reviewer_id column — undefined_column, not merely hidden'
);
reset role;

-- 13. authenticated has exactly SELECT on company_reviews_public
select ok(
  (
    select array_agg(privilege_type::text order by privilege_type)
    from information_schema.role_table_grants
    where table_name = 'company_reviews_public' and grantee = 'authenticated'
  ) = array['SELECT'],
  'authenticated has exactly SELECT on company_reviews_public'
);

-- 14. anon has no privileges on company_reviews_public
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_reviews_public' and grantee = 'anon'$$,
  'anon has no privileges on company_reviews_public'
);

-- 15. anon cannot select company_reviews (base table)
set local role anon;
select throws_ok(
  $$select id from company_reviews$$,
  '42501',
  null,
  'anon cannot SELECT company_reviews — no privilege granted'
);
reset role;

-- =========================================================================
-- Section C: company_review_verifications (schema-only, service_role only)
-- =========================================================================

-- 16. RLS is enabled
select ok(
  (select relrowsecurity from pg_class where oid = 'public.company_review_verifications'::regclass),
  'RLS is enabled on company_review_verifications'
);

-- 17. authenticated has no privileges at all — schema-only this phase, same as moderation_cases before its moderator-role follow-up
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_review_verifications' and grantee = 'authenticated'$$,
  'authenticated has no privileges on company_review_verifications'
);

-- 18. anon has no privileges at all
select is_empty(
  $$select privilege_type from information_schema.role_table_grants
      where table_name = 'company_review_verifications' and grantee = 'anon'$$,
  'anon has no privileges on company_review_verifications'
);

-- 19. service_role can insert a verification record
set local role service_role;
select lives_ok(
  $$insert into company_review_verifications (review_id, method, evidence_snapshot)
    values ('dddddddd-9003-1111-1111-111111111111', 'corporate_email', '{"domain": "reviewco.example"}'::jsonb)$$,
  'service_role can insert into company_review_verifications'
);
reset role;

select * from finish();
rollback;
