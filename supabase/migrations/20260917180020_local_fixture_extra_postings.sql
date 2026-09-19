-- Two more local fixture postings.
--
-- WHY. The three seeded postings from 20260917170000 each already have a
-- terminal 'succeeded' attempt, and a succeeded attempt counts as ACTIVE for
-- createAttemptIfNoneActive (eligibilityGate.ts ACTIVE_ATTEMPT_STATUSES) — so
-- planApplication deliberately refuses to open a second application against the
-- same posting. That is correct behaviour and worth keeping: one application
-- per posting.
--
-- It does mean the resume-tailoring flow cannot be demonstrated end to end
-- against an already-applied-to posting without either rewriting the history of
-- an existing attempt or bypassing the attempt-creation rule. Both would be
-- worse than adding a posting. These are additive, unmistakably labelled
-- fixture rows pointing at the same local mock employer route.
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
    ('local-fixture-4', 'http://127.0.0.1:5000/mock-employer/apply?posting=4', '[MOCK] Data Engineer — Local Fixture (tailoring)'),
    ('local-fixture-5', 'http://127.0.0.1:5000/mock-employer/apply?posting=5', '[MOCK] Data Analyst — Local Fixture (tailoring)')
) as v (source_vacancy_id, authoritative_url, raw_title)
on conflict do nothing;
