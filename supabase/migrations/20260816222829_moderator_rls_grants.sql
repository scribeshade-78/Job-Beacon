-- Moderator read/write access to the R3 trust and moderation tables,
-- gated by is_moderator() rather than by table-level grants alone:
-- granting SELECT to `authenticated` broadly, then restricting actual row
-- visibility with a USING (is_moderator()) policy, is how a *subset* of
-- authenticated users (moderators) can see rows other authenticated users
-- (candidates) must not. A non-moderator's SELECT still succeeds at the
-- grant level but the policy filters it to zero rows — an empty result,
-- not a 42501 error, the same behavior R1's cross-candidate isolation
-- tests already rely on.
grant select on public.vacancy_trust_scores to authenticated;
create policy "vacancy_trust_scores_select_moderator"
  on public.vacancy_trust_scores
  for select
  to authenticated
  using (is_moderator());

grant select on public.vacancy_flags to authenticated;
create policy "vacancy_flags_select_moderator"
  on public.vacancy_flags
  for select
  to authenticated
  using (is_moderator());

grant select on public.vacancy_evidence to authenticated;
create policy "vacancy_evidence_select_moderator"
  on public.vacancy_evidence
  for select
  to authenticated
  using (is_moderator());

grant select on public.moderation_cases to authenticated;
create policy "moderation_cases_select_moderator"
  on public.moderation_cases
  for select
  to authenticated
  using (is_moderator());

-- moderation_decisions: moderators can also record new decisions (§19.1's
-- clear/flag/block/request-info/escalate actions), but never update or
-- delete existing ones — immutability holds even for moderators
-- themselves (§21.2 "moderation decisions cannot be deleted; corrections
-- create new versions"). The WITH CHECK also pins reviewer_id to the
-- caller, so a moderator can only ever record a decision as themselves,
-- never attribute it to another reviewer.
grant select, insert on public.moderation_decisions to authenticated;

create policy "moderation_decisions_select_moderator"
  on public.moderation_decisions
  for select
  to authenticated
  using (is_moderator());

create policy "moderation_decisions_insert_moderator"
  on public.moderation_decisions
  for insert
  to authenticated
  with check (is_moderator() and reviewer_id = auth.uid());
