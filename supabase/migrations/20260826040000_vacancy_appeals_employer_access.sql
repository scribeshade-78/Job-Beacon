-- R5.4c: vacancy_appeals (20260816231315) was built service_role-only,
-- deliberately, since no employer auth/account system existed yet at the
-- time — "filer_id is a generic auth.users reference so the column shape
-- is correct once an employer-claim system exists, but nothing can file
-- one through the app yet." That system now exists (R5.4a). Filing itself
-- still completes via a server-side route under service_role (never a
-- direct candidate/employer INSERT) — same "system-generated,
-- worker-written" precedent as employer_claims and every other
-- employer-facing table this arc has built. This migration only adds the
-- read side: the filer can see their own appeal's status/history.
grant select on public.vacancy_appeals to authenticated;

create policy "vacancy_appeals_select_own"
  on public.vacancy_appeals
  for select
  to authenticated
  using ((select auth.uid()) = filer_id);
