-- Task B1 (Mini-Phase 1): the cover letter's storage.
--
-- ONE COLUMN, DELIBERATELY. This phase is backend generation and storage only —
-- no UI, no submission adapter — so the smallest thing that lets a generated
-- letter be generated, kept and inspected is a column on the row that already
-- identifies "this application".
--
-- WHY application_attempts AND NOT application_plans. A cover letter is
-- produced per submission attempt, the same way a tailored resume is: it is
-- generated against one vacancy at one moment, and the plan is the durable
-- candidate-vacancy pairing rather than the act of applying. That also matches
-- where resume_document_id already lives (20260917180000), so the two pieces of
-- generated material sit on the same row.
--
-- NULLABLE, AND NULL MEANS SOMETHING. Every attempt that exists today has no
-- cover letter and never had one — a backfill would have to invent text for
-- applications that were submitted long ago, which is exactly the fabrication
-- this feature is built to prevent. NULL means "no letter was generated for
-- this attempt", and the submission path is expected to treat it as absent
-- rather than as an empty letter.
--
-- NOT PROVENANCE. There is deliberately no model_version / prompt_version /
-- cited_facts column here, even though the generator knows all three and the
-- resume path records its equivalents on resume_documents. The task scoped this
-- phase to one column, and adding three more on the strength of "the resume
-- does it" would be guessing at a provenance design for a table whose other
-- generated artifact is stored elsewhere. Worth a follow-up decision before a
-- second phase stores letters that nobody can reproduce.
alter table public.application_attempts
  add column cover_letter_text text;

comment on column public.application_attempts.cover_letter_text is
  'Cover letter generated for this attempt, as plain text paragraphs. NULL means no letter was generated (not an empty letter). Subject to the same factRefs citation gate as generated resumes — see server/applications/coverLetterGenerator.ts.';
