-- Reviewer separation enforcement (PRD §13.2 step 31 "Appeal window and
-- reviewer separation enforced"; §13.4 "Moderator cannot review their own
-- prior decision on appeal"). appeal_id links a decision to the specific
-- appeal it resolves — nullable, since most decisions aren't appeal
-- resolutions. A trigger (not just the RLS policy) enforces the
-- separation, so the invariant holds universally, including for
-- service_role inserts, not only RLS-restricted authenticated ones — the
-- same reasoning hard-block rules use for overriding the numeric score
-- regardless of caller.
alter table public.moderation_decisions add column appeal_id uuid references public.vacancy_appeals (id);

create index moderation_decisions_appeal_id_idx on public.moderation_decisions (appeal_id);

create or replace function public.enforce_appeal_reviewer_separation()
returns trigger
language plpgsql
as $$
declare
  original_reviewer_id uuid;
begin
  if new.appeal_id is not null then
    select md.reviewer_id into original_reviewer_id
    from public.vacancy_appeals va
    join public.moderation_decisions md on md.id = va.moderation_decision_id
    where va.id = new.appeal_id;

    if original_reviewer_id is null then
      raise exception 'vacancy_appeals % does not reference a resolvable moderation_decisions row.', new.appeal_id;
    end if;

    if original_reviewer_id = new.reviewer_id then
      raise exception 'Reviewer separation violation: reviewer % cannot decide an appeal of their own original decision.', new.reviewer_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_appeal_reviewer_separation_trigger
  before insert on public.moderation_decisions
  for each row
  execute function public.enforce_appeal_reviewer_separation();
