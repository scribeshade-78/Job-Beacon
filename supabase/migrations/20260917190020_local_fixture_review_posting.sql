-- One more local fixture posting, for the review gate.
--
-- Same reasoning as 20260917180020: createAttemptIfNoneActive refuses to open a
-- second application against a posting that already has an active attempt (and
-- 'succeeded' counts as active, so every earlier posting is spent). The review
-- flow needs a posting with no attempt against it, and adding a labelled
-- fixture row is a smaller lie than rewriting the history of an existing one.
--
-- One row, not two: the whole flow — held, not claimed, approved, claimed —
-- happens against this single posting.
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
    ('local-fixture-6', 'http://127.0.0.1:5000/mock-employer/apply?posting=6', '[MOCK] Data Engineer — Local Fixture (review gate)')
) as v (source_vacancy_id, authoritative_url, raw_title)
on conflict do nothing;
