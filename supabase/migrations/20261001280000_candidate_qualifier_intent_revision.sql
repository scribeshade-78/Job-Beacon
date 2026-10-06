-- D1 — publication must compare against the CURRENT intent, not just its own rows.
--
-- THE REMAINING RACE. Staged publication (20261001260000) stops a failed refresh
-- from emptying the cache and stops two generations mixing. It does NOT stop an
-- OLDER refresh from overwriting NEWER saved intent: refresh A reads intent,
-- the candidate edits it, refresh B publishes, and A then publishes its own
-- generation over the top — reverting the candidate's edit while looking
-- perfectly successful.
--
-- THE MECHANISM: a compare-and-swap on the intent the generation was derived
-- from. candidate_qualifier_generations already points at the current
-- generation; this adds the INTENT FINGERPRINT that generation was derived from,
-- and publication becomes:
--
--   update candidate_qualifier_generations
--      set generation = <new>, intent_fingerprint = <observed>
--    where candidate_id = <c> and intent_fingerprint = <observed>
--
-- Zero affected rows means the pointer moved while this refresh was working, so
-- this generation is STALE and must NOT be published. It is not an error: the
-- newer refresh owns publication. The candidate keeps the newer intent.
--
-- WHY NOT tokenizer_version ALONE. tokenizer_version proves the derivation RULE
-- is current; it says nothing about whether the candidate's INTENT, the vacancy
-- corpus or the role matches are. Each is a separate input with its own
-- fingerprint, and conflating them is how a refresh silently ranks on stale
-- intent.
--
-- DISTINGUISHABLE STATES, all four:
--   never derived        no row in candidate_qualifier_generations
--   explicitly empty     a row whose generation has no token rows
--   failed refresh       no pointer move, previous row intact
--   stale generation     a generation that lost the CAS and was never published
-- The fourth is why "stale" is reported rather than thrown.
alter table public.candidate_qualifier_generations
  add column intent_fingerprint text;

comment on column public.candidate_qualifier_generations.intent_fingerprint is
  'Fingerprint of the confirmed saved intent (candidate_selected_roles role_name + raw_role_name) this generation was derived from. Publication is a compare-and-swap on it, so a refresh derived from older intent cannot overwrite a newer generation. NULL for rows published before this migration: those predate the guard and are treated as unverifiable, requiring one re-derivation.';

-- Reads join through the pointer, so a stale-but-unpublished generation is
-- simply unreachable. Nothing needs to delete it eagerly.
create index if not exists candidate_qualifier_generations_intent_idx
  on public.candidate_qualifier_generations (candidate_id, intent_fingerprint);

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — none executed here; not a database test.
--
-- 1. Reverse-order completion is safe: publish generation A, then simulate a
--    refresh derived from older intent attempting the CAS —
--      update public.candidate_qualifier_generations
--         set generation = '<stale>', intent_fingerprint = '<old>'
--       where candidate_id = '<c>' and intent_fingerprint = '<old>';
--      -- expect 0 rows affected, and the pointer unchanged
--
-- 2. Every published generation belongs to its candidate:
--      select g.candidate_id, count(t.*)
--      from public.candidate_qualifier_generations g
--      left join public.candidate_qualifier_tokens t
--        on t.candidate_id = g.candidate_id and t.generation = g.generation
--      group by 1;    -- no generation may join another candidate's rows
--
-- 3. Explicitly empty stays distinguishable from never derived (see
--    20261001260000).
--
-- ROLLBACK
--   alter table public.candidate_qualifier_generations drop column intent_fingerprint;
-- ---------------------------------------------------------------------------
