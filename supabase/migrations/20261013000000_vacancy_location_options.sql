-- ---------------------------------------------------------------------------
-- Phase 2 - the location options the Countries and Cities pickers offer.
--
-- WHY AN RPC RATHER THAN TWO SELECTs FROM THE BROWSER. The pickers must offer values
-- that ACTUALLY EXIST in the data, and the table is the only authority on that.
-- PostgREST cannot express DISTINCT, so the alternative is fetching every row and
-- deduplicating in JavaScript - O(table), and it would quietly become the slowest
-- request in the app as the catalogue grows.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: IT DOES NOT INVENT A COUNTRY LIST. Adzuna
-- serves 19 markets and nothing else carries a structured country, so a picker built
-- from "every ISO-2 country" would offer markets that CANNOT return a single job.
-- That is the exact defect this proposal set out to remove - a location control that
-- looks like a choice and matches nothing. Offering only countries present in
-- vacancies means a candidate can select somewhere we can actually search.
--
-- status = 'active' BECAUSE AN EXPIRED LISTING MUST NOT ADVERTISE A MARKET. A country
-- whose only vacancies have expired would appear in the picker and then filter to an
-- empty feed - the same lie in a new place.
--
-- NULL AND BLANK ARE EXCLUDED: a NULL country means "unknown", not a country whose
-- name is the empty string. btrim catches the rows that stored whitespace.
--
-- SECURITY INVOKER, called with the service client, matching the other read RPCs.
-- ---------------------------------------------------------------------------
create or replace function public.vacancy_location_options()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'countries', coalesce((
      select jsonb_agg(distinct country order by country)
        from public.vacancies
       where status = 'active'
         and country is not null
         and btrim(country) <> ''
    ), '[]'::jsonb),
    'cities', coalesce((
      select jsonb_agg(distinct city order by city)
        from public.vacancies
       where status = 'active'
         and city is not null
         and btrim(city) <> ''
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.vacancy_location_options() from public;
grant execute on function public.vacancy_location_options() to service_role;
