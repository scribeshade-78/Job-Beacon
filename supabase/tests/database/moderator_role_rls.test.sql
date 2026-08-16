begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- Fixture setup (as postgres, bypasses RLS — not under test).
insert into auth.users (id, email) values
  ('11111111-5555-1111-1111-111111111111', 'moderator-a@test.local'),
  ('22222222-5555-1111-1111-111111111111', 'candidate-b@test.local');

insert into user_roles (user_id, role) values
  ('11111111-5555-1111-1111-111111111111', 'moderator');

insert into source_policies (source_code, authentication_method, policy_version, countries)
values ('greenhouse', 'none', 'r2-v1', array['US']);

insert into companies (id, displayed_name, domain)
values ('cccccccc-5555-1111-1111-111111111111', 'Roleco', 'roleco.example');

insert into vacancy_sources (id, source_code, target_key)
values ('dddddddd-5555-1111-1111-111111111111', 'greenhouse', 'roleco');

insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, company_id)
values ('eeeeeeee-5555-1111-1111-111111111111', 'greenhouse', 'dddddddd-5555-1111-1111-111111111111', 'job-role-1', 'https://roleco.example/jobs/1', 'Role Test Position', 'cccccccc-5555-1111-1111-111111111111');

insert into vacancy_trust_scores (id, vacancy_id, status, score, policy_version)
values ('ffffffff-5555-1111-1111-111111111111', 'eeeeeeee-5555-1111-1111-111111111111', 'FLAGGED', 42, 'r3-trust-score-v1');

insert into vacancy_flags (vacancy_trust_score_id, reason_code)
values ('ffffffff-5555-1111-1111-111111111111', 'DOMAIN_MISMATCH_WITH_NO_EXPLANATION');

insert into vacancy_evidence (vacancy_trust_score_id, evidence_type, payload)
values ('ffffffff-5555-1111-1111-111111111111', 'domain_check', '{"match": false}'::jsonb);

insert into moderation_cases (id, vacancy_id, source_type, severity, evidence_snapshot)
values ('99999999-5555-1111-1111-111111111111', 'eeeeeeee-5555-1111-1111-111111111111', 'rule', 'high', '{"trust_score": 42}'::jsonb);

insert into moderation_decisions (id, moderation_case_id, reviewer_id, decision, rationale, policy_version)
values ('88888888-5555-1111-1111-111111111111', '99999999-5555-1111-1111-111111111111', '11111111-5555-1111-1111-111111111111', 'flagged', 'Domain mismatch, needs manual review.', 'r3-moderation-v1');

-- =========================================================================
-- Section A: is_moderator()
-- =========================================================================

set local role authenticated;
set local request.jwt.claim.sub = '11111111-5555-1111-1111-111111111111';

-- 1. returns true for a user with the moderator role
select ok(
  (select is_moderator()),
  'is_moderator() returns true for a user with the moderator role'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '22222222-5555-1111-1111-111111111111';

-- 2. returns false for a user without the moderator role
select ok(
  not (select is_moderator()),
  'is_moderator() returns false for a user without the moderator role'
);
reset role;

-- =========================================================================
-- Section B-E: SELECT visibility — moderator sees rows, candidate gets an
-- empty result (not an error — the grant exists, RLS filters the rows).
-- =========================================================================

set local role authenticated;
set local request.jwt.claim.sub = '11111111-5555-1111-1111-111111111111';

-- 3. moderator can select vacancy_trust_scores
select results_eq(
  $$select status from vacancy_trust_scores where id = 'ffffffff-5555-1111-1111-111111111111'$$,
  $$values ('FLAGGED'::text)$$,
  'moderator can SELECT vacancy_trust_scores'
);

-- 4. moderator can select vacancy_flags
select results_eq(
  $$select reason_code from vacancy_flags where vacancy_trust_score_id = 'ffffffff-5555-1111-1111-111111111111'$$,
  $$values ('DOMAIN_MISMATCH_WITH_NO_EXPLANATION'::text)$$,
  'moderator can SELECT vacancy_flags'
);

-- 5. moderator can select vacancy_evidence
select results_eq(
  $$select evidence_type from vacancy_evidence where vacancy_trust_score_id = 'ffffffff-5555-1111-1111-111111111111'$$,
  $$values ('domain_check'::text)$$,
  'moderator can SELECT vacancy_evidence'
);

-- 6. moderator can select moderation_cases
select results_eq(
  $$select severity from moderation_cases where id = '99999999-5555-1111-1111-111111111111'$$,
  $$values ('high'::text)$$,
  'moderator can SELECT moderation_cases'
);

-- 7. moderator can select moderation_decisions
select results_eq(
  $$select decision from moderation_decisions where id = '88888888-5555-1111-1111-111111111111'$$,
  $$values ('flagged'::text)$$,
  'moderator can SELECT moderation_decisions'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '22222222-5555-1111-1111-111111111111';

-- 8. candidate SELECT on vacancy_trust_scores is empty, not an error
select is_empty(
  $$select status from vacancy_trust_scores$$,
  'candidate (non-moderator) SELECT on vacancy_trust_scores is empty'
);

-- 9. candidate SELECT on vacancy_flags is empty
select is_empty(
  $$select reason_code from vacancy_flags$$,
  'candidate (non-moderator) SELECT on vacancy_flags is empty'
);

-- 10. candidate SELECT on vacancy_evidence is empty
select is_empty(
  $$select evidence_type from vacancy_evidence$$,
  'candidate (non-moderator) SELECT on vacancy_evidence is empty'
);

-- 11. candidate SELECT on moderation_cases is empty
select is_empty(
  $$select severity from moderation_cases$$,
  'candidate (non-moderator) SELECT on moderation_cases is empty'
);

-- 12. candidate SELECT on moderation_decisions is empty
select is_empty(
  $$select decision from moderation_decisions$$,
  'candidate (non-moderator) SELECT on moderation_decisions is empty'
);
reset role;

-- =========================================================================
-- Section F: moderation_decisions writes
-- =========================================================================

set local role authenticated;
set local request.jwt.claim.sub = '11111111-5555-1111-1111-111111111111';

-- 13. moderator can insert a decision attributed to themselves
select lives_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version)
    values ('99999999-5555-1111-1111-111111111111', '11111111-5555-1111-1111-111111111111', 'escalated', 'Escalating for a second opinion.', 'r3-moderation-v1')$$,
  'moderator can INSERT a moderation_decisions row attributed to themselves'
);

-- 14. moderator cannot insert a decision attributed to a different reviewer
select throws_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version)
    values ('99999999-5555-1111-1111-111111111111', '22222222-5555-1111-1111-111111111111', 'cleared', 'x', 'r3-moderation-v1')$$,
  '42501',
  null,
  'moderator cannot INSERT a moderation_decisions row attributed to a different reviewer'
);

-- 15. moderator cannot UPDATE an existing decision — immutable even for moderators
select throws_ok(
  $$update moderation_decisions set rationale = 'edited' where id = '88888888-5555-1111-1111-111111111111'$$,
  '42501',
  null,
  'moderator cannot UPDATE an existing moderation_decisions row'
);

-- 16. moderator cannot DELETE an existing decision
select throws_ok(
  $$delete from moderation_decisions where id = '88888888-5555-1111-1111-111111111111'$$,
  '42501',
  null,
  'moderator cannot DELETE an existing moderation_decisions row'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '22222222-5555-1111-1111-111111111111';

-- 17. a non-moderator candidate cannot insert any decision at all
select throws_ok(
  $$insert into moderation_decisions (moderation_case_id, reviewer_id, decision, rationale, policy_version)
    values ('99999999-5555-1111-1111-111111111111', '22222222-5555-1111-1111-111111111111', 'cleared', 'x', 'r3-moderation-v1')$$,
  '42501',
  null,
  'a non-moderator candidate cannot INSERT into moderation_decisions'
);
reset role;

-- =========================================================================
-- Section G: anon sanity check — role membership is irrelevant to anon,
-- which still has zero grants regardless (matching R3.1/R3.5 precedent).
-- =========================================================================

set local role anon;

-- 18. anon still denied on vacancy_trust_scores
select throws_ok(
  $$select status from vacancy_trust_scores$$,
  '42501',
  null,
  'anon is still denied on vacancy_trust_scores regardless of moderator grants'
);

-- 19. anon still denied on moderation_decisions
select throws_ok(
  $$select decision from moderation_decisions$$,
  '42501',
  null,
  'anon is still denied on moderation_decisions regardless of moderator grants'
);
reset role;

select * from finish();
rollback;
