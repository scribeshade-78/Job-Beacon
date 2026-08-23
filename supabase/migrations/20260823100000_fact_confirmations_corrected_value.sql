-- MP-F2: fact confirmation UI needs to record a candidate's correction
-- separately from the original extracted value — extracted_facts.fact_value
-- must never be mutated by candidate action (it's the extraction
-- provenance record). null means "confirmed exactly as extracted"; non-null
-- means the candidate edited it when confirming. fact_confirmations has
-- zero writers as of this migration (confirmed empty, same as MP-F1's
-- provenance migration), so this NOT-NULL-free nullable add needs no
-- backfill either way.
alter table public.fact_confirmations
  add column corrected_value text;
