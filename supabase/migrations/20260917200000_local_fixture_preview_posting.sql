-- Another local fixture posting, for the candidate preview workflow.
--
-- Same reason as 20260917180020 and 20260917190020: createAttemptIfNoneActive
-- refuses a second application against a posting that already has an active
-- attempt, and 'succeeded' counts as active, so each end-to-end run consumes
-- one posting.
--
-- This treadmill is worth naming rather than quietly extending: the honest fix
-- is a scripted "reset the local fixture postings" helper for demos, not an
-- unbounded series of one-row migrations. That is deliberately left undone
-- here rather than invented mid-verification — the fixture still works, and a
-- reset helper is a product decision about what demo state should look like.
with target as (
  select id from public.vacancy_sources
  where source_code = 'local_fixture' and target_key = 'local-fixture-board'
)
insert into public.vacancies (
  source_code,
  vacancy_source_id,
  source_vacancy_id,
  authoritative_url,
  raw_title,
  country,
  status,
  trust_status
)
select
  'local_fixture',
  target.id,
  v.source_vacancy_id,
  v.authoritative_url,
  v.raw_title,
  'XX',
  'active',
  'VERIFIED'
from target
cross join (
  values
    ('local-fixture-7', 'http://127.0.0.1:5000/mock-employer/apply?posting=7', '[MOCK] Data Engineer — Local Fixture (candidate preview)')
) as v (source_vacancy_id, authoritative_url, raw_title)
on conflict do nothing;
