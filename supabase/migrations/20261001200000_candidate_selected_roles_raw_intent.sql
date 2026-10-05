-- D1/Decision 2 — preserve what the candidate actually asked for.
--
-- THE PROBLEM. candidate_selected_roles.role_name stores the CATALOG TITLE for a
-- taxonomy selection and the typed text for a custom role. So a candidate who
-- searched "Azure Data Engineer" and picked Data Engineer has "Data Engineer"
-- saved: the Azure intent existed only in a search box, was dropped at
-- persistence, and could not influence matching afterwards. Displaying the word
-- somewhere would not fix that — it has to be STORED.
--
-- WHAT THIS ADDS. Two nullable columns, additive only:
--
--   raw_role_name    the candidate's own phrase, exactly as they requested or
--                    confirmed it. NULL means UNKNOWN, never "the same as
--                    role_name".
--   normalized_role_id  the stable taxonomy id the selection came from, when it
--                    came from the catalog. The id, not the title, so a later
--                    retitle cannot silently rewrite what was saved.
--
-- role_name KEEPS ITS EXACT MEANING. Every existing consumer (eligibilityGate's
-- role_match, searchPreferences.buildSearchPreferences, the target-roles panel)
-- keeps reading it unchanged, and the unique (candidate_id, role_name) key still
-- governs duplicates. This migration breaks nothing and rewrites nothing.
--
-- HISTORICAL ROWS ARE EXPLICITLY UNKNOWN. No row is backfilled: reconstructing
-- "Azure Data Engineer" from a saved "Data Engineer" would be inventing intent
-- the candidate never recorded, and it would be indistinguishable from a real
-- record afterwards. Existing rows keep NULL in both columns, and readers must
-- treat NULL as "not recorded" — not as "same as role_name".
--
-- RAW INTENT IS ONLY EVER WHAT THE CANDIDATE CONFIRMED. A generic search query
-- that returned several roles is NOT each role's raw intent, so a client must
-- write raw_role_name only from an explicit selection/confirmation, never from
-- the query box on the candidate's behalf.
alter table public.candidate_selected_roles
  add column raw_role_name text;

alter table public.candidate_selected_roles
  add column normalized_role_id text;

comment on column public.candidate_selected_roles.raw_role_name is
  'The candidate''s own phrase, exactly as requested or confirmed. NULL means NOT RECORDED (historical rows, or a selection the client could not attribute to an explicit confirmation) — never "the same as role_name". Written only from an explicit selection, never copied from a search box.';

comment on column public.candidate_selected_roles.normalized_role_id is
  'Stable shared/roleTaxonomy.ts id this selection came from, or NULL for a custom role. The id rather than the title, so a future retitle cannot rewrite saved intent.';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; not a database test.
--
-- 1. Columns exist and are nullable:
--      select column_name, is_nullable from information_schema.columns
--      where table_name = 'candidate_selected_roles' order by column_name;
--
-- 2. No historical row was invented:
--      select count(*) from public.candidate_selected_roles
--      where raw_role_name is not null or normalized_role_id is not null;
--      -- expect 0 immediately after applying
--
-- 3. role_name semantics and uniqueness are unchanged:
--      select pg_get_constraintdef(oid) from pg_constraint
--      where conname like 'candidate_selected_roles%';
--      -- expect the same primary key and unique (candidate_id, role_name)
--
-- 4. Ownership still applies to the new columns (they are on an existing
--    RLS-protected table; no new grant is introduced):
--      -- as another candidate, selecting this table must return zero rows
--
-- DEPLOYMENT ORDERING — SCHEMA FIRST, THEN CLIENT. A client that writes
-- raw_role_name against an un-migrated database gets 42703 (column does not
-- exist) on INSERT and the save fails loudly; it does not corrupt anything,
-- because role_name is written in the same statement. Applying this migration
-- before the client ships is nevertheless required.
--
-- ROLLBACK
--   alter table public.candidate_selected_roles
--     drop column raw_role_name,
--     drop column normalized_role_id;
--   Only the newly recorded raw intent is lost; role_name and every established
--   consumer are untouched.
-- ---------------------------------------------------------------------------
