-- MP-F1: the resume fact extraction pipeline (first real writer of
-- extracted_facts) must record model + prompt version with every
-- extraction (PRD evidence rule) — no column existed to hold that.
-- extracted_facts has zero writers as of this migration (confirmed: no
-- INSERT anywhere in the repository before MP-F1, and this table is
-- select-only for `authenticated`), so both columns are added NOT NULL
-- with no default/backfill — there are no existing rows that could
-- violate the constraint.
alter table public.extracted_facts
  add column extraction_model text not null,
  add column extraction_prompt_version text not null;
