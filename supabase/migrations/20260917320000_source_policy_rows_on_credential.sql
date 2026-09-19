-- Task H3 correction: do NOT seed source_policies rows for the ATS sources.
--
-- WHAT WENT WRONG. 20260917310000 inserted greenhouse and lever rows into
-- source_policies. That broke the database suite: 20 pgTAP files open by
-- inserting their own source_policies fixture row, e.g.
--
--   insert into source_policies (source_code, authentication_method, policy_version)
--   values ('greenhouse', 'none', 'r2-v1');
--
-- and a seeded row turns every one of those into
--
--   ERROR: duplicate key value violates unique constraint "source_policies_pkey"
--
-- before a single assertion runs. Confirmed against the live database on
-- vacancy_trust_rls.test.sql and by counting the affected files (20).
--
-- THE SEEDING WAS ALSO UNNECESSARY, which is what makes this the right fix
-- rather than editing twenty test fixtures. eligibilityGate.ts's
-- evaluateSourcePolicy reads the row with maybeSingle() and falls back to false:
--
--   automatedApplicationAllowed: policy?.automated_application_allowed ?? false
--
-- so an ABSENT row and a row with the flag false are the same answer to the
-- gate. Seeding therefore changed no behaviour while breaking the suite.
--
-- WHAT REPLACES IT. The derivation function now CREATES the row the moment an
-- active employer credential exists, and otherwise only ever turns the flag off
-- on a row that already exists. That is the §10.2 requirement stated positively:
-- direct application is enabled by the arrival of employer authorization, and a
-- deployment with no employer relationships has no policy row claiming
-- otherwise.
--
-- The test fixtures stay untouched, which also preserves their meaning: each one
-- still creates an all-flags-false policy row and tests against exactly that.

-- Remove the rows this task seeded, but only where no credential justifies them.
-- A deployment that had already installed a credential keeps its row.
delete from public.source_policies sp
where sp.source_code in ('greenhouse', 'lever')
  and not exists (
    select 1
    from public.ats_credentials c
    where c.source_code = sp.source_code
      and c.is_active
  );

create or replace function public.refresh_source_application_policy()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
  v_authorized boolean;
begin
  foreach v_source in array array['greenhouse', 'lever']
  loop
    select exists (
      select 1
      from public.ats_credentials c
      where c.source_code = v_source
        and c.is_active
    ) into v_authorized;

    if v_authorized then
      insert into public.source_policies (
        source_code, discovery_allowed, storage_allowed, display_allowed,
        automated_application_allowed, authentication_method, rate_limit, countries, policy_version
      ) values (
        v_source, true, true, true, true, 'employer_issued_api_key',
        'Employer-controlled ATS API. Submission is proxied server-side (PRD 10.2).',
        '{IN,US,EU}', 'h3-v1'
      )
      on conflict (source_code) do update
        set automated_application_allowed = true,
            updated_at = now();
    else
      update public.source_policies
         set automated_application_allowed = false,
             updated_at = now()
       where source_code = v_source;
    end if;
  end loop;
end;
$$;

comment on function public.refresh_source_application_policy() is
  'Enables automated_application_allowed for an ATS source only while an active employer credential exists, creating the policy row when authorization arrives (PRD v3 §10.2). Never creates a row for an unauthorized source: an absent row already fails the source_policy gate, and seeding one would collide with the pgTAP fixtures that create their own.';

revoke all on function public.refresh_source_application_policy() from public, anon, authenticated;
