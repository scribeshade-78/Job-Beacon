-- Explicit "open to any location" preference (Phase 0 Task 2).
--
-- WHY THIS EXISTS. Preference readiness requires explicit location intent, and
-- before this column that intent could only be expressed by naming countries or
-- cities. A candidate who is genuinely open to anywhere had no way to say so:
-- preferred_countries = '{}' means "not stated", so their list stayed empty and
-- their setup could never complete.
--
-- WHY NOT reuse an empty array or a sentinel string. preferred_countries and
-- preferred_cities are text[] documented as ISO country names/codes and city
-- names; '{}' already means "not stated" and adding a magic value like 'ANY'
-- would collide with a real country code, make every reader special-case it, and
-- silently change the meaning of existing rows. A boolean is the smallest
-- representation that cannot be confused with a place name.
--
-- WHY IT IS SEPARATE FROM remote_preference = 'any'. Those are different axes and
-- conflating them would be a real bug: remote_preference says "I do not mind
-- whether the work is remote, hybrid or on-site" while this says "I do not mind
-- where the job is". A candidate can perfectly well want remote work in a
-- specific country, or be willing to relocate anywhere for on-site work.
-- 20260917340000's own column comment already draws the NULL-vs-'any' line for
-- work mode; this column is the geographic counterpart and must not be derived
-- from it.
--
-- DEFAULT false, AND NOT NULL, DELIBERATELY. false is the truthful state for
-- every existing row: nothing has ever been recorded about geographic openness,
-- and silently treating "unknown" as "anywhere" would widen every existing
-- candidate's search scope without their saying so. Enabling it is an explicit
-- candidate action.
--
-- RETAINED LOCATIONS ARE NOT DELETED. Enabling this does not clear
-- preferred_countries or preferred_cities, so turning it back off restores the
-- previous scope exactly. The read path is what honours the flag; the stored
-- lists are left intact. See shared/readiness.ts for the precedence rule and the
-- comment below for how readers must interpret the combination.
alter table public.candidate_preferences
  add column open_to_any_location boolean not null default false;

comment on column public.candidate_preferences.open_to_any_location is
  'Geographic scope only: true means any location is acceptable, so preferred_countries/preferred_cities are not required and are treated as no restriction while it is true. Independent of remote_preference, which is about work mode. Retained country/city selections are preserved and apply again if this is set back to false.';

-- VALIDATION QUERIES — run after applying, none executed here.
--
-- 1. Every existing row took the conservative default:
--      select count(*) from public.candidate_preferences where open_to_any_location;  -- expect 0
--
-- 2. No locations were removed by this migration:
--      select count(*) from public.candidate_preferences
--      where cardinality(preferred_countries) > 0 or cardinality(preferred_cities) > 0;
--    (compare against the same count taken before applying)
--
-- ROLLBACK
--   alter table public.candidate_preferences drop column open_to_any_location;
--   Reversible without data loss: the column carries no information that is not
--   re-derivable from the candidate's explicit action, and no other column was
--   modified.
