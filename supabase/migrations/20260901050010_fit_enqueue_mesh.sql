-- Opportunity Intelligence Phase 2.3b — keeps the stored priority score
-- (fit_analyses.priority_*) fresh when one of its inputs changes outside
-- the fit worker's existing trigger set.
--
-- Existing enqueue paths, unchanged by this migration:
--   * fit_enqueue_on_fact_confirmed (20260831120020) — confirmed facts.
--   * enqueueFitJobsForVacancy (TS, server/opportunities/enqueue.ts), called
--     from scoreVacancy.ts. Phase 2.3b broadens its call site from "entering
--     VERIFIED" to "any trust bucket transition", which is what keeps the
--     company_credibility factor fresh. That is a TypeScript change, not a
--     trigger, because trust scoring already runs server-side.
--
-- Everything added here is a DB trigger rather than an Express hook for the
-- same reason fit_enqueue_on_fact_confirmed is one: the writes it reacts to
-- either happen browser-side under RLS with no server code in the path
-- (candidate_selected_roles), or must hold no matter which process performs
-- them (the message -> application link). SECURITY DEFINER with a pinned
-- search_path, per the existing convention.

-- response_stage is 25% of the score — the single heaviest factor — so it
-- gets the most care. A message only becomes a stage signal once it is BOTH
-- classified AND linked to an application, and those two steps happen in
-- different workers in either order:
--   * poll.ts classifies inline, while messages.application_attempt_id is
--     still NULL (the common case);
--   * matchBatch.ts links the message later, scanning for
--     application_attempt_id IS NULL;
--   * a prompt-version backfill (runMessageClassificationBatch) re-writes
--     classifications for messages that are already linked.
-- So both edges get a trigger sharing one body, and each is a no-op unless
-- the other half is already present. The join below is all-inner: it yields
-- no row (and enqueues nothing) until message + classification + attempt +
-- plan all exist.
create function public.fit_enqueue_on_message_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_message uuid;
  target         record;
begin
  if tg_table_name = 'response_classifications' then
    target_message := new.message_id;
  else
    target_message := new.id;
  end if;

  select ap.candidate_id, ap.vacancy_id
    into target
  from public.messages m
  join public.response_classifications rc on rc.message_id = m.id
  join public.application_attempts aa on aa.id = m.application_attempt_id
  join public.application_plans ap on ap.id = aa.application_plan_id
  where m.id = target_message;

  if not found then
    return new;
  end if;

  insert into public.fit_analysis_jobs (candidate_id, vacancy_id)
  values (target.candidate_id, target.vacancy_id)
  on conflict (candidate_id, vacancy_id)
  do update set status = 'pending', attempts = 0, last_error = null, updated_at = now();

  return new;
end;
$$;

-- Edge 1: the matcher links an already-classified message.
create trigger fit_enqueue_on_message_linked_trigger
  after update of application_attempt_id on public.messages
  for each row
  when (
    new.application_attempt_id is not null
    and new.application_attempt_id is distinct from old.application_attempt_id
  )
  execute function public.fit_enqueue_on_message_signal();

-- Edge 2: a classification is written (or re-written by a prompt-version
-- backfill) for a message that is already linked. The classifier upserts on
-- message_id, so this must cover UPDATE as well as INSERT.
create trigger fit_enqueue_on_classification_trigger
  after insert or update on public.response_classifications
  for each row
  execute function public.fit_enqueue_on_message_signal();

-- user_preferences (5%): candidate_selected_roles is written browser-side
-- under RLS (client/src/lib/candidateSelectedRoles.ts selectRole/removeRole)
-- with no server code in the path, so this has to be a trigger — the same
-- reasoning as fit_enqueue_on_fact_confirmed. UPDATE is covered too because
-- candidate_selected_roles deliberately carries an UPDATE grant (a candidate
-- correcting a typo in a role name is an edit, not a delete-and-reinsert),
-- and an edited role name changes what it matches.
--
-- candidate_exclusions deliberately gets NO trigger: its four categories
-- (staffing_agencies, contract_roles, relocation_required,
-- sensitive_sectors) have no corresponding signal anywhere on vacancies, so
-- toggling one moves no factor today. Add one when a vacancy-side
-- classification for those categories actually exists.
--
-- ponytail: fan-out inside a trigger, bounded by the count of currently
-- VERIFIED/VERIFIED_INCOMPLETE vacancies — the identical ceiling
-- fit_enqueue_on_fact_confirmed already accepts at pre-launch volume;
-- revisit (batch enqueue, or a reconcile pass in worker:fit) if that count
-- grows large.
create function public.fit_enqueue_on_selected_roles()
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
  on conflict (candidate_id, vacancy_id)
  do update set status = 'pending', attempts = 0, last_error = null, updated_at = now();

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger fit_enqueue_on_selected_roles_trigger
  after insert or update or delete on public.candidate_selected_roles
  for each row
  execute function public.fit_enqueue_on_selected_roles();
