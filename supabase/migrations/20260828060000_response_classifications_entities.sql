-- Response Intelligence Phase 1 (AI Understanding Pipeline): entity
-- extraction columns on response_classifications. Additive only — the
-- table, its RLS policy, and its grants (20260820140020) are unchanged;
-- `authenticated` already has SELECT on the whole row, so the new columns
-- are readable by the owning candidate with no policy change, and
-- service_role already has full DML.
--
-- All extracted_* columns are nullable: the classifier emits null for any
-- entity the message does not actually state — same "never guess" rule
-- extracted_facts already follows. extracted_salary_text is deliberately
-- free text, never a numeric column: a recruiter email's salary phrasing
-- ("12-18 LPA", "£45k + equity") must not be coerced into an unlabeled
-- figure (salary-source-labeling invariant); a later phase that resolves
-- it against a labeled salary model owns any structured form.
--
-- prompt_version mirrors resume extraction's extraction_prompt_version:
-- model_version alone (already on this table) is not enough to reproduce a
-- classification — the prompt text is the other half. Nullable because
-- rows written before this migration have no known prompt version.
--
-- raw_extraction keeps the model's full JSON output verbatim for audit and
-- re-processing, same precedent as vacancy_evidence.payload / messages.raw_payload.
--
-- The unique index on message_id makes classification idempotent: the
-- worker upserts on re-run (poll retry, backfill batch, prompt-version
-- bump) instead of accumulating duplicate rows. One current classification
-- per message; classification history is out of scope this phase.

alter table public.response_classifications
  add column prompt_version        text,
  add column extracted_company     text,
  add column extracted_role        text,
  add column extracted_job_id      text,
  add column extracted_deadline    date,
  add column extracted_salary_text text,
  add column raw_extraction        jsonb;

create unique index response_classifications_message_id_key
  on public.response_classifications (message_id);
