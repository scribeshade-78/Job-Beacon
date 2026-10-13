-- ---------------------------------------------------------------------------
-- The destination split on auto-apply consumption: India vs US.
--
-- WHY THIS IS ADDITIVE AND NOT A REWRITE. candidate_entitlement_usage feeds
-- evaluateEntitlements, which gates features for paying customers. A silent change to an
-- existing column there would not show a wrong number on a card - it would give someone a
-- different allowance than they paid for. So the five original columns are reproduced
-- EXACTLY as they were, and the split arrives as two new columns beside them.
--
-- THE DESTINATION WAS ALREADY IN THE DATA. consumption counts application_attempts joined
-- to application_plans, and application_plans.vacancy_id -> vacancies.country is one join
-- away. Nothing needed to be collected; the split was simply never asked for until
-- per-destination quota enforcement arrived.
--
-- THE WINDOW IS UNCHANGED. candidate_billing_period already returns the billing period,
-- which IS the week on a weekly plan - exactly the window max_auto_apply_*_per_week
-- describes. No windowing work was needed.
--
-- NULL COUNTRY BELONGS TO NEITHER BUCKET, deliberately. 265 vacancies carry a NULL
-- country (only the Adzuna adapter sets one), so india + us will NOT equal the total for
-- most candidates. The remainder is real and the UI shows it, rather than folding
-- unattributable attempts into a destination they did not come from.
-- ---------------------------------------------------------------------------
begin;

drop function public.candidate_entitlement_usage(uuid);

create function public.candidate_entitlement_usage(p_candidate_id uuid)
returns table (
  active_target_roles integer,
  verified_applications_this_period integer,
  consumed_applications_this_period integer,
  ats_resume_variants integer,
  connected_mailboxes integer,
  consumed_applications_india_this_period integer,
  consumed_applications_us_this_period integer
)
language sql
security invoker
stable
as $$
  with period as (select * from public.candidate_billing_period(p_candidate_id))
  select
    (select count(*)::integer
       from public.candidate_selected_roles r
      where r.candidate_id = p_candidate_id),
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
      where pl.candidate_id = p_candidate_id
        and a.status = 'succeeded'
        and a.succeeded_at >= (select p.starts_at from period p)),
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
      where pl.candidate_id = p_candidate_id
        and a.status <> 'cancelled'
        and a.created_at >= (select p.starts_at from period p)),
    (select count(*)::integer
       from public.resume_documents d
      where d.candidate_id = p_candidate_id
        and d.kind = 'tailored'),
    (select count(*)::integer
       from public.mailbox_connections m
      where m.candidate_id = p_candidate_id
        and m.status = 'connected'),
    -- NEW: same predicate as consumed_* above, plus the destination.
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
       join public.vacancies v on v.id = pl.vacancy_id
      where pl.candidate_id = p_candidate_id
        and a.status <> 'cancelled'
        and a.created_at >= (select p.starts_at from period p)
        and v.country = 'IN'),
    (select count(*)::integer
       from public.application_attempts a
       join public.application_plans pl on pl.id = a.application_plan_id
       join public.vacancies v on v.id = pl.vacancy_id
      where pl.candidate_id = p_candidate_id
        and a.status <> 'cancelled'
        and a.created_at >= (select p.starts_at from period p)
        and v.country = 'US');
$$;

comment on function public.candidate_entitlement_usage(uuid) is
  'Usage for the countable PRD v3 27.2 dimensions, over the CANDIDATE''S BILLING PERIOD rather than a calendar month. verified_* counts succeeded attempts; consumed_* counts every attempt except cancelled and is the one a quota must compare against. consumed_applications_{india,us}_this_period split consumed_* by vacancies.country; attempts against a NULL-country vacancy are in consumed_* and in NEITHER split, so india + us <= consumed in general.';

revoke all on function public.candidate_entitlement_usage(uuid) from public, anon, authenticated;
grant execute on function public.candidate_entitlement_usage(uuid) to service_role;

commit;
