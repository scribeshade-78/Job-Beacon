-- Task A2: claim a fit-analysis job for a SPECIFIC set of vacancies.
--
-- WHY THE EXISTING RPC CANNOT DO THIS. claim_fit_analysis_job() is FIFO over
-- every pending row (order by created_at) with no way to narrow the set. That
-- is correct for the scheduled drain it was written for — oldest work first —
-- but it makes "score the vacancies I just ingested" impossible: with 131
-- pending jobs, of which 16 were the new ones, a batch of any size processes
-- the OLDEST rows and the new vacancies sit behind 115 others. A bounded batch
-- would therefore have scored other people's backlog and left the new jobs
-- unscored, which is the opposite of what was asked for.
--
-- So this is the same claim, same lease, same skip-locked discipline, with one
-- extra predicate. Deliberately a separate function rather than a nullable
-- parameter on the existing one: the scheduled worker should keep calling a
-- function whose behaviour cannot be changed by an argument, and the two
-- callers have genuinely different questions ("the oldest work" vs "this work").
create function public.claim_fit_analysis_jobs_for_vacancies(p_vacancy_ids uuid[])
returns setof public.fit_analysis_jobs
language plpgsql
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.fit_analysis_jobs
  where vacancy_id = any(p_vacancy_ids)
    and (status = 'pending' or (status = 'leased' and leased_until < now()))
    and attempts < max_attempts
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  update public.fit_analysis_jobs
  set status = 'leased',
      leased_until = now() + interval '5 minutes',
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id;

  return query select * from public.fit_analysis_jobs where id = claimed_id;
end;
$$;

revoke all on function public.claim_fit_analysis_jobs_for_vacancies(uuid[]) from public;
revoke all on function public.claim_fit_analysis_jobs_for_vacancies(uuid[]) from anon;
revoke all on function public.claim_fit_analysis_jobs_for_vacancies(uuid[]) from authenticated;
grant execute on function public.claim_fit_analysis_jobs_for_vacancies(uuid[]) to service_role;

comment on function public.claim_fit_analysis_jobs_for_vacancies(uuid[]) is
  'Same claim-and-lease as claim_fit_analysis_job, restricted to the given vacancy ids. Used by on-demand intake so freshly ingested vacancies are scored immediately instead of queueing behind the existing backlog.';
