-- Task B1 Mini-Phase 2: provenance for the generated cover letter.
--
-- THE GAP THIS CLOSES. Mini-Phase 1 stored cover_letter_text and nothing else,
-- so a stored letter could not be reproduced, audited, or even dated. The
-- resume path records model_version and prompt_version for exactly this reason
-- (response_classifications, resume_documents); a letter generated without them
-- is an assertion with no evidence behind it, which is a strange thing for the
-- one artifact in this product that is free prose written in the candidate's
-- name.
--
-- THE SPLIT, AND WHY IT IS NOT ALL ONE SHAPE.
--
--   The scalars are columns: model_version, prompt_version, generated_at.
--   These are the things an operator queries and filters on ("which letters
--   came from the prompt before the name fix?", "what did we generate last
--   Tuesday?"), and a column can be indexed and NOT NULL-ed.
--
--   The per-paragraph citations are jsonb. They are a paragraph-index -> fact-id
--   map, which is a structure with no fixed arity, and the only thing anyone
--   will ever do with it is read it whole to answer "what backed this
--   sentence?". Four parallel array columns to model that would be worse in
--   every way.
--
-- THE INTEGRITY RULE IS THE POINT OF THE PHASE, so it is a constraint rather
-- than a convention: a row may not hold cover_letter_text without also holding
-- its prompt_version and generated_at. A letter with no provenance is precisely
-- what this migration exists to make impossible, and leaving that as "the
-- generator will always set them" would put the guarantee in the one place it
-- can silently stop being true.
--
-- CONSEQUENCE, HANDLED EXPLICITLY: one letter already exists in this database
-- with no provenance — written by Mini-Phase 1's verification harness, which
-- called the generator directly and stored only the text. The constraint cannot
-- be added while it is there, and inventing provenance for it would be
-- fabricating exactly the audit record being added. It is cleared instead, with
-- that stated plainly rather than quietly.
alter table public.application_attempts
  add column cover_letter_model_version  text,
  add column cover_letter_prompt_version text,
  add column cover_letter_generated_at   timestamptz,
  add column cover_letter_metadata       jsonb;

-- Clear the un-provenanced letter rather than backfilling a story for it.
update public.application_attempts
  set cover_letter_text = null
  where cover_letter_text is not null
    and (cover_letter_prompt_version is null or cover_letter_generated_at is null);

alter table public.application_attempts
  add constraint application_attempts_cover_letter_provenance_check
  check (
    cover_letter_text is null
    or (cover_letter_prompt_version is not null and cover_letter_generated_at is not null)
  );

comment on column public.application_attempts.cover_letter_text is
  'Cover letter generated for this attempt, as plain text paragraphs. NULL means no letter was generated (not an empty letter). Subject to the same factRefs citation gate as generated resumes — see server/applications/coverLetterGenerator.ts, and cover_letter_metadata for the citations that gate approved.';

comment on column public.application_attempts.cover_letter_metadata is
  'Audit evidence for cover_letter_text: the per-paragraph fact citations the model returned and the honesty gate approved, plus the cited fact count. Written by the same call that wrote the text.';
