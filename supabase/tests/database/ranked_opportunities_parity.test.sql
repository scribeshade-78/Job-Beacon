-- UNEXECUTED — no isolated Postgres/Supabase instance is available in this
-- session. This file documents the database fixtures that MUST run against one
-- before any claim of SQL parity, RLS, trigger or concurrency correctness is
-- made. Nothing here has been executed, and the mocked TypeScript tests are NOT
-- database verification.
--
-- Run with: supabase test db   (or psql against a disposable local database)
-- Requires migrations through 20261001340000_candidate_ranked_opportunities.sql.
--
-- WHAT ONLY A DATABASE CAN PROVE:
--   * the SQL canonical-input builders agree with shared/rankingInputs.ts for the
--     same rows (cross-language parity of the JSONB shape);
--   * the association-preserving COUNT(DISTINCT qualifier) matches
--     shared/candidateQualifiers.assessAssociatedQualifiers;
--   * applicability is decided INSIDE the ranked query's snapshot;
--   * evidence completeness is assessed over the whole corpus, not the page;
--   * candidate isolation and no row duplication.

begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- ---------------------------------------------------------------------------
-- Fixtures.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'rank-a@test.local'),
  ('b2b2b2b2-2222-2222-2222-222222222222', 'rank-b@test.local');

insert into candidate_profiles (id) values
  ('a1a1a1a1-1111-1111-1111-111111111111'),
  ('b2b2b2b2-2222-2222-2222-222222222222');

insert into source_policies (source_code, authentication_method, policy_version)
values ('greenhouse', 'none', 'r2-v1');
insert into vacancy_sources (id, source_code, target_key)
values ('c3c3c3c3-3333-3333-3333-333333333333', 'greenhouse', 'acme');

-- Three browseable vacancies: a matching Data Engineer that mentions Azure, a
-- generic matching Data Engineer that does not, and an unrelated Nurse that
-- does mention Azure.
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, status, trust_status) values
  ('d1d1d1d1-1111-1111-1111-111111111111', 'greenhouse', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-1', 'https://boards.greenhouse.io/acme/jobs/1', 'Data Engineer',    'active', 'VERIFIED'),
  ('d2d2d2d2-2222-2222-2222-222222222222', 'greenhouse', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-2', 'https://boards.greenhouse.io/acme/jobs/2', 'Data Engineer II', 'active', 'VERIFIED'),
  ('d3d3d3d3-3333-3333-3333-333333333333', 'greenhouse', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-3', 'https://boards.greenhouse.io/acme/jobs/3', 'Registered Nurse', 'active', 'VERIFIED');

insert into vacancy_versions (id, vacancy_id, raw_payload, content_hash) values
  ('aa000001-0000-0000-0000-000000000001', 'd1d1d1d1-1111-1111-1111-111111111111', '{}'::jsonb, 'hash-1'),
  ('aa000002-0000-0000-0000-000000000002', 'd2d2d2d2-2222-2222-2222-222222222222', '{}'::jsonb, 'hash-2'),
  ('aa000003-0000-0000-0000-000000000003', 'd3d3d3d3-3333-3333-3333-333333333333', '{}'::jsonb, 'hash-3');

-- Snapshot per vacancy. The token row records the SAME clean_text and title, so
-- vacancy_evidence_is_current() is true for all three.
insert into vacancy_jd_snapshots (id, vacancy_id, vacancy_version_id, canonical_url, clean_text, sections, source_code, extractor_version) values
  ('e0000000-0000-0000-0000-000000000001', 'd1d1d1d1-1111-1111-1111-111111111111', 'aa000001-0000-0000-0000-000000000001', 'https://boards.greenhouse.io/acme/jobs/1', 'Build pipelines on Azure.', '[]'::jsonb, 'greenhouse', 'jd-extract-v1'),
  ('e0000000-0000-0000-0000-000000000002', 'd2d2d2d2-2222-2222-2222-222222222222', 'aa000002-0000-0000-0000-000000000002', 'https://boards.greenhouse.io/acme/jobs/2', 'General posting text.', '[]'::jsonb, 'greenhouse', 'jd-extract-v1'),
  ('e0000000-0000-0000-0000-000000000003', 'd3d3d3d3-3333-3333-3333-333333333333', 'aa000003-0000-0000-0000-000000000003', 'https://boards.greenhouse.io/acme/jobs/3', 'Azure cloud nurse role.', '[]'::jsonb, 'greenhouse', 'jd-extract-v1');

insert into vacancy_evidence_tokens (vacancy_id, jd_snapshot_id, tokenizer_version, evidence_fingerprint, input_title, input_clean_text, tokens) values
  ('d1d1d1d1-1111-1111-1111-111111111111', 'e0000000-0000-0000-0000-000000000001', 'evidence-tokens-v1', 'fp1', 'Data Engineer',    'Build pipelines on Azure.', array['data','engineer','build','pipelines','on','azure']),
  ('d2d2d2d2-2222-2222-2222-222222222222', 'e0000000-0000-0000-0000-000000000002', 'evidence-tokens-v1', 'fp2', 'Data Engineer II', 'General posting text.',    array['data','engineer','ii','general','posting','text']),
  ('d3d3d3d3-3333-3333-3333-333333333333', 'e0000000-0000-0000-0000-000000000003', 'evidence-tokens-v1', 'fp3', 'Registered Nurse', 'Azure cloud nurse role.',  array['registered','nurse','azure','cloud','role']);

-- Candidate A: one role, raw phrase adds "azure".
insert into candidate_selected_roles (id, candidate_id, role_name, raw_role_name) values
  ('f1f1f1f1-1111-1111-1111-111111111111', 'a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'Azure Data Engineer');

-- Candidate B: two roles, each with its own qualifier.
insert into candidate_selected_roles (id, candidate_id, role_name, raw_role_name) values
  ('f2f2f2f2-2222-2222-2222-222222222222', 'b2b2b2b2-2222-2222-2222-222222222222', 'Data Engineer', 'Azure Data Engineer'),
  ('f3f3f3f3-3333-3333-3333-333333333333', 'b2b2b2b2-2222-2222-2222-222222222222', 'Teacher',       'Montessori Teacher');

-- Candidate A's published role coverage, recording the canonical inputs.
insert into candidate_role_match_coverage
  (candidate_id, published_generation, corpus_complete, matcher_version, status, scanned, matched,
   published_corpus_version, role_input_canonical)
values
  ('a1a1a1a1-1111-1111-1111-111111111111',
   '11111111-1111-1111-1111-111111111111', true, 'role-taxonomy-v1', 'complete', 3, 2,
   (select version from public.vacancy_corpus_version),
   '[{"role_name": "Data Engineer"}]'::jsonb);

-- Candidate A matches only the two Data Engineer vacancies.
insert into candidate_role_matches (candidate_id, role_name, vacancy_id, generation, matcher_version, input_title) values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'd1d1d1d1-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'role-taxonomy-v1', 'Data Engineer'),
  ('a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'd2d2d2d2-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'role-taxonomy-v1', 'Data Engineer II');

-- Candidate A's published qualifier generation, recording the canonical intent.
insert into candidate_qualifier_generations (candidate_id, generation, tokenizer_version, intent_fingerprint, intent_canonical)
values
  ('a1a1a1a1-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'evidence-tokens-v1', 'ifp-a',
   '[{"role_name": "Data Engineer", "raw_role_name": "Azure Data Engineer"}]'::jsonb);

insert into candidate_qualifier_tokens (candidate_id, role_name, qualifier, tokenizer_version, intent_fingerprint, generation) values
  ('a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'azure', 'evidence-tokens-v1', 'ifp-a', '22222222-2222-2222-2222-222222222222');

-- Candidate B: same role coverage and matches (different generation ids), plus a
-- Teacher qualifier that must never boost a Data Engineer vacancy.
insert into candidate_role_match_coverage
  (candidate_id, published_generation, corpus_complete, matcher_version, status, scanned, matched,
   published_corpus_version, role_input_canonical)
values
  ('b2b2b2b2-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', true, 'role-taxonomy-v1', 'complete', 3, 2,
   (select version from public.vacancy_corpus_version),
   '[{"role_name": "Data Engineer"}, {"role_name": "Teacher"}]'::jsonb);
insert into candidate_role_matches (candidate_id, role_name, vacancy_id, generation, matcher_version, input_title) values
  ('b2b2b2b2-2222-2222-2222-222222222222', 'Data Engineer', 'd1d1d1d1-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'role-taxonomy-v1', 'Data Engineer');
insert into candidate_qualifier_generations (candidate_id, generation, tokenizer_version, intent_fingerprint, intent_canonical)
values
  ('b2b2b2b2-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'evidence-tokens-v1', 'ifp-b',
   '[{"role_name": "Data Engineer", "raw_role_name": "Azure Data Engineer"}, {"role_name": "Teacher", "raw_role_name": "Montessori Teacher"}]'::jsonb);
insert into candidate_qualifier_tokens (candidate_id, role_name, qualifier, tokenizer_version, intent_fingerprint, generation) values
  ('b2b2b2b2-2222-2222-2222-222222222222', 'Data Engineer', 'azure', 'evidence-tokens-v1', 'ifp-b', '44444444-4444-4444-4444-444444444444'),
  ('b2b2b2b2-2222-2222-2222-222222222222', 'Teacher', 'montessori', 'evidence-tokens-v1', 'ifp-b', '44444444-4444-4444-4444-444444444444');

-- ---------------------------------------------------------------------------
-- 1-2. Cross-language canonical parity.
-- ---------------------------------------------------------------------------
select is(
  public.candidate_role_inputs_canonical('a1a1a1a1-1111-1111-1111-111111111111'),
  '[{"role_name": "Data Engineer"}]'::jsonb,
  'role_inputs_canonical matches the shared/rankingInputs.ts shape'
);

select is(
  public.candidate_intent_canonical('b2b2b2b2-2222-2222-2222-222222222222'),
  '[{"role_name": "Data Engineer", "raw_role_name": "Azure Data Engineer"}, {"role_name": "Teacher", "raw_role_name": "Montessori Teacher"}]'::jsonb,
  'intent_canonical matches the shared/rankingInputs.ts shape'
);

-- ---------------------------------------------------------------------------
-- 3-9. Applicability and association-preserving score (candidate A).
-- ---------------------------------------------------------------------------
select ok(public.role_match_coverage_applies('a1a1a1a1-1111-1111-1111-111111111111'), 'role coverage applies');
select ok(public.qualifier_generation_applies('a1a1a1a1-1111-1111-1111-111111111111'), 'qualifier generation applies');
select ok(public.posting_evidence_complete(), 'posting evidence is complete over the browseable corpus');
select is(public.candidate_ranking_state('a1a1a1a1-1111-1111-1111-111111111111'), 'current', 'state is current when everything applies');

select is(
  public.candidate_ranked_matched_qualifiers('a1a1a1a1-1111-1111-1111-111111111111', 'd1d1d1d1-1111-1111-1111-111111111111'),
  1,
  'a matching vacancy that mentions Azure scores one matched qualifier'
);

select is(
  public.candidate_ranked_matched_qualifiers('a1a1a1a1-1111-1111-1111-111111111111', 'd2d2d2d2-2222-2222-2222-222222222222'),
  0,
  'a generic relevant Data Engineer still scores a confirmed ZERO (not excluded)'
);

select is(
  public.candidate_ranked_matched_qualifiers('a1a1a1a1-1111-1111-1111-111111111111', 'd3d3d3d3-3333-3333-3333-333333333333'),
  0,
  'an unrelated Azure posting scores nothing'
);

-- ---------------------------------------------------------------------------
-- 10-11. Association across multiple roles (candidate B).
-- ---------------------------------------------------------------------------
select is(
  public.candidate_ranked_matched_qualifiers('b2b2b2b2-2222-2222-2222-222222222222', 'd1d1d1d1-1111-1111-1111-111111111111'),
  1,
  'only the qualifier whose ROLE the vacancy matches counts (Teacher''s qualifier ignored)'
);

select is(
  (
    select count(*)::int
    from public.candidate_ranked_opportunities
    where id = 'd3d3d3d3-3333-3333-3333-333333333333'
  ),
  0,
  'a vacancy matching no selected role is absent from the ranked rows'
);

-- ---------------------------------------------------------------------------
-- 12-13. Legacy / stale inputs are never current, and score is NULL then.
-- ---------------------------------------------------------------------------
set local role service_role;
update public.candidate_qualifier_generations
  set intent_canonical = null
  where candidate_id = 'a1a1a1a1-1111-1111-1111-111111111111';
reset role;

select is(public.candidate_ranking_state('a1a1a1a1-1111-1111-1111-111111111111'), 'updating', 'a legacy NULL canonical input is updating, never current');

set local role authenticated;
set local request.jwt.claims to '{"sub":"a1a1a1a1-1111-1111-1111-111111111111"}';
select is(
  (select matched_qualifier_count from public.candidate_ranked_opportunities where id = 'd1d1d1d1-1111-1111-1111-111111111111'),
  null,
  'matched_qualifier_count is NULL while ranking is not current'
);
reset role;

-- ---------------------------------------------------------------------------
-- 14-15. Evidence completeness is assessed over the corpus, not the page.
-- ---------------------------------------------------------------------------
-- Add a browseable vacancy with NO token row; A's page would still contain
-- indexed rows, so a page-local check would wrongly call the feed current.
insert into vacancies (id, source_code, vacancy_source_id, source_vacancy_id, authoritative_url, raw_title, status, trust_status)
values ('d4d4d4d4-4444-4444-4444-444444444444', 'greenhouse', 'c3c3c3c3-3333-3333-3333-333333333333', 'gh-4', 'https://boards.greenhouse.io/acme/jobs/4', 'Data Engineer III', 'active', 'VERIFIED');

select is(public.posting_evidence_complete(), false, 'one unindexed browseable vacancy makes the whole corpus incomplete');
select is(public.candidate_ranking_state('a1a1a1a1-1111-1111-1111-111111111111'), 'updating', 'so the state is updating, never a partial boost labelled current');

-- ---------------------------------------------------------------------------
-- 16-18. No duplication and candidate isolation.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"a1a1a1a1-1111-1111-1111-111111111111"}';
select is(
  (select count(*) from public.candidate_ranked_opportunities),
  (select count(distinct id) from public.candidate_ranked_opportunities),
  'the ranked view never duplicates a vacancy row'
);

select is(
  (select candidate_id::text from public.candidate_ranking_status),
  'a1a1a1a1-1111-1111-1111-111111111111',
  'the status view is scoped to the calling candidate'
);
select is(
  (select count(*)::int from public.candidate_ranked_opportunities where ranking_candidate_id <> 'a1a1a1a1-1111-1111-1111-111111111111'),
  0,
  'no ranked row can carry another candidate''s ranking id'
);
reset role;

-- ---------------------------------------------------------------------------
-- 19-20. no_target_roles is neutral, and write paths stay backend-only.
-- ---------------------------------------------------------------------------
insert into candidate_profiles (id) values ('c0c0c0c0-0000-0000-0000-000000000000');
select is(public.candidate_ranking_state('c0c0c0c0-0000-0000-0000-000000000000'), 'no_target_roles', 'a candidate with no selected roles is neutral, not failed');

set local role authenticated;
set local request.jwt.claims to '{"sub":"a1a1a1a1-1111-1111-1111-111111111111"}';
select throws_ok(
  $$insert into public.candidate_qualifier_tokens (candidate_id, role_name, qualifier, tokenizer_version, intent_fingerprint, generation)
    values ('a1a1a1a1-1111-1111-1111-111111111111', 'Data Engineer', 'forged', 'evidence-tokens-v1', 'x', '55555555-5555-5555-5555-555555555555')$$,
  '42501',
  null,
  'authenticated cannot forge a qualifier that would boost its own feed'
);
reset role;

select * from finish();
rollback;
