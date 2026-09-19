-- Task I: candidate preferences, separated from on-the-fly vacancy filters.
--
-- PRD v3 §21.1 names the Candidate entity as "candidate_profiles,
-- candidate_preferences, candidate_selected_roles, candidate_exclusions". Of
-- those four, only candidate_profiles, candidate_selected_roles and
-- candidate_exclusions exist — this creates the missing candidate_preferences.
--
-- TWO MECHANISMS, NOT ONE, AND THAT IS THE POINT OF THE TASK. A preference is
-- durable, belongs to the candidate, and describes what they want. A filter is
-- transient, belongs to one browsing session, and describes what they are
-- looking at right now. They overlap on three fields (location, employment type,
-- salary), and the overlap is exactly where a naive design puts two inputs that
-- can disagree. Keeping them in separate stores is what lets the UI DERIVE the
-- filter's starting value from the preference instead of asking twice.
--
-- WHY ARRAYS RATHER THAN JOIN TABLES. Every one of these lists is small, bounded,
-- always read whole with its parent, and never queried across candidates. A
-- child table per list would add five joins to the one query that reads this row
-- and buy nothing. The existing candidate_exclusions table stays as it is: it
-- models a different thing — a closed set of exclusion CATEGORIES that the
-- matching engine reasons about — not free-text values a candidate types.

create table public.candidate_preferences (
  candidate_id uuid primary key references public.candidate_profiles (id) on delete cascade,

  -- ---- Location / Remote preference ----
  /** ISO country names or codes as stored on vacancies.country. Free text because that column is. */
  preferred_countries text[] not null default '{}',
  preferred_cities text[] not null default '{}',
  /** NULL means "no preference stated", which is not the same as 'any'. See the column comment below. */
  remote_preference text,

  -- ---- Employment type ----
  /**
   * Recorded but NOT yet applied to matching: vacancies have no employment_type
   * column, so there is nothing to match against. Stored because it is the
   * candidate's stated preference and the column is the only place it belongs;
   * flagged in the UI rather than presented as a working filter.
   */
  employment_types text[] not null default '{}',

  -- ---- Work authorization / sponsorship ----
  /** Also recorded but not applied: vacancies carry no sponsorship or authorization data. */
  work_authorization text,
  requires_sponsorship boolean,

  -- ---- Minimum salary ----
  /** Annualised, in min_salary_currency. NULL means no floor stated. */
  min_salary numeric,
  min_salary_currency text,

  -- ---- Relocation ----
  willing_to_relocate boolean,

  -- ---- Exclusions by name ----
  /** Matched case-insensitively against companies.displayed_name. */
  excluded_companies text[] not null default '{}',
  /** Matched case-insensitively against company_profiles.industry. */
  excluded_industries text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (remote_preference is null or remote_preference in ('remote', 'hybrid', 'on_site', 'any')),
  check (work_authorization is null or work_authorization in ('citizen', 'permanent_resident', 'visa_required', 'other')),
  check (min_salary is null or min_salary >= 0),
  check (min_salary_currency is null or length(min_salary_currency) = 3),
  -- A salary floor without a currency is not a floor. 80000 means different
  -- things in INR and USD, and defaulting one would silently mis-filter.
  check (min_salary is null or min_salary_currency is not null),
  check (employment_types <@ array['full_time', 'part_time', 'contract', 'internship', 'temporary']::text[])
);

comment on table public.candidate_preferences is
  'Durable candidate preferences (PRD v3 §21.1 Candidate domain). One row per candidate. Distinct from OpportunityFilters, which is transient per-search state and lives only in the browser.';

comment on column public.candidate_preferences.remote_preference is
  'NULL and ''any'' are deliberately different: NULL is "the candidate has not said", ''any'' is "the candidate has said they do not mind". A filter derived from NULL stays open; one derived from ''any'' is explicitly unrestricted, and the UI labels the two differently.';

comment on column public.candidate_preferences.employment_types is
  'Stored but not yet applied to matching: public.vacancies has no employment_type column. Recorded because it is the candidate''s stated preference; the UI must not present it as a working filter.';

comment on column public.candidate_preferences.work_authorization is
  'Stored but not yet applied: vacancies carry no work-authorization or sponsorship data (PRD v3 §16.1 makes candidate eligibility a separate gate, not a vacancy column).';

alter table public.candidate_preferences enable row level security;

revoke all on public.candidate_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.candidate_preferences to authenticated;
grant select, insert, update, delete on public.candidate_preferences to service_role;

-- Same _own shape candidate_profiles and candidate_selected_roles already use:
-- keyed by auth.uid(), so a candidate reaching this table directly through
-- PostgREST can only ever touch their own row.
create policy "candidate_preferences_select_own"
  on public.candidate_preferences for select to authenticated
  using (candidate_id = (select auth.uid()));

create policy "candidate_preferences_insert_own"
  on public.candidate_preferences for insert to authenticated
  with check (candidate_id = (select auth.uid()));

create policy "candidate_preferences_update_own"
  on public.candidate_preferences for update to authenticated
  using (candidate_id = (select auth.uid()))
  with check (candidate_id = (select auth.uid()));

create policy "candidate_preferences_delete_own"
  on public.candidate_preferences for delete to authenticated
  using (candidate_id = (select auth.uid()));
