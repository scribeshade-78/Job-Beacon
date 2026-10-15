-- Bound the fit-enqueue fan-out.
--
-- THE LEAK. fit_enqueue_on_fact_confirmed and fit_enqueue_on_selected_roles both fan out
-- across EVERY VERIFIED/VERIFIED_INCOMPLETE vacancy. Observed live: a single role selection
-- by a single candidate queued 743 fit_analysis_jobs rows, and each row is one model call
-- once drained. The cost is therefore O(candidates x verified vacancies) - it grows with
-- the catalogue rather than with candidate activity, and nothing bounds it. At one
-- candidate that is merely wasteful; the ceiling the mesh migration accepted ("pre-launch
-- volume") scales with the catalogue being the whole point of the product.
--
-- THE FIX. Cap both fan-outs at the newest 200 vacancies. worker:fit --reconcile
-- (server/opportunities/reconcile.ts) back-fills the remainder over time under its own
-- limit, which is exactly the remedy the mesh migration itself anticipated: "revisit (batch
-- enqueue, or a reconcile pass in worker:fit) if that count grows large".
--
-- WHAT THIS DELIBERATELY IS NOT - an authorization gate. fit_analyses is a candidate-facing
-- read surface (20260831120010_fit_analyses.sql: "Candidate-facing read surface only"), so
-- gating the enqueue on automation_authorizations would hide fit scores from candidates who
-- have not authorized automation - the population that most needs to see them. That consent
-- gate governs acting ON a candidate's behalf (submissionAdapter, eligibilityGate,
-- readinessGate), not analysing a vacancy for them.
--
-- 200 IS A PRODUCT NUMBER, NOT A TECHNICAL ONE. It bounds the burst a single candidate
-- action can cause. Anything older than the newest 200 waits for the reconcile pass.
--
-- ORDERING IS PART OF THE CONTRACT. created_at desc, so the candidate's freshest
-- opportunities are scored eagerly and the backfill covers the tail; id breaks ties so the
-- cap cannot select a different 200 between two otherwise identical runs. This matters
-- because a non-deterministic cap would make "which vacancies have no score" unreproducible.
--
-- The message-signal trigger is untouched: it enqueues at most one (candidate, vacancy)
-- pair per message, so it has no fan-out to bound.

create or replace function public.fit_enqueue_on_fact_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_candidate_id uuid;
begin
  select ef.candidate_id into owner_candidate_id
  from public.extracted_facts ef
  where ef.id = new.extracted_fact_id;

  if owner_candidate_id is null then
    return new;
  end if;

  insert into public.fit_analysis_jobs (candidate_id, vacancy_id)
  select owner_candidate_id, v.id
  from public.vacancies v
  where v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE')
  order by v.created_at desc, v.id desc
  limit 200
  on conflict (candidate_id, vacancy_id)
  do update set status = 'pending', attempts = 0, last_error = null, updated_at = now();

  return new;
end;
$$;

create or replace function public.fit_enqueue_on_selected_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_candidate uuid;
begin
  if tg_op = 'DELETE' then
    target_candidate := old.candidate_id;
  else
    target_candidate := new.candidate_id;
  end if;

  insert into public.fit_analysis_jobs (candidate_id, vacancy_id)
  select target_candidate, v.id
  from public.vacancies v
  where v.trust_status in ('VERIFIED', 'VERIFIED_INCOMPLETE')
  order by v.created_at desc, v.id desc
  limit 200
  on conflict (candidate_id, vacancy_id)
  do update set status = 'pending', attempts = 0, last_error = null, updated_at = now();

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
