begin;
select plan(4);

create temporary table t_plan as select id from application_plans limit 1;
create temporary table t_cand as select candidate_id from application_plans where id = (select id from t_plan);

-- The cancellation sweep cancels attempts for candidates who are not authorized, which would
-- make every assertion below pass vacuously. Pin an authorized candidate first.
insert into automation_authorizations (candidate_id, status, consent_version, created_at, status_changed_at)
select candidate_id, 'authorized', 'pgtap', now(), now() from t_cand
on conflict (candidate_id) do update set status = 'authorized', status_changed_at = now();

insert into application_attempts (application_plan_id, status, attempts, max_attempts, leased_by, lease_token, leased_until)
select id, 'leased', 1, 5, 'extension', gen_random_uuid(), now() - interval '1 hour' from t_plan;

select is(
  (select count(*)::int from claim_application_attempt()),
  0,
  'an EXPIRED EXTENSION lease is never claimed by the unattended worker'
);

insert into application_attempts (application_plan_id, status, attempts, max_attempts, leased_by, lease_token, leased_until)
select id, 'leased', 1, 5, 'worker', gen_random_uuid(), now() - interval '1 hour' from t_plan;

select is(
  (select count(*)::int from claim_application_attempt()),
  1,
  'an expired WORKER lease is still reclaimed, so the worker is not starved'
);

select is(
  (select leased_by from application_attempts where application_plan_id = (select id from t_plan) and leased_until > now()),
  'worker',
  'the row the worker took is marked leased_by = worker'
);

delete from application_attempts where application_plan_id = (select id from t_plan) and status = 'leased';
insert into application_attempts (application_plan_id, status, attempts, max_attempts, leased_by, lease_token, leased_until)
select id, 'leased', 1, 5, 'extension', gen_random_uuid(), now() - interval '25 hours' from t_plan;
select count(*) from claim_application_attempt();

select is(
  (select status from application_attempts where application_plan_id = (select id from t_plan) and status <> 'failed' and status <> 'pending_review' or (status = 'pending_review' and leased_by = 'worker' and lease_token is null) order by updated_at desc limit 1),
  'pending_review',
  'an ABANDONED extension lease is released to pending_review, which nothing unattended may claim'
);

select * from finish();
rollback;
