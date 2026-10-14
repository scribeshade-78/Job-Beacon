-- Resume document text (Phase 6).
--
-- WHY THIS EXISTS. The review screen shows a word diff between the resume the
-- candidate uploaded and the one we tailored for the role. NEITHER TEXT WAS
-- STORED ANYWHERE: tailorResumeForVacancy builds its prompt from confirmed
-- extracted_facts, storeTailoredResume renders the result to a PDF through
-- Playwright, and the TailoredResumeContent it started from is dropped. The base
-- document's own text is extracted inside extractFacts and dropped there too. So
-- "what changed" could not be answered after the fact by any reader, including
-- us, which is why the review screen could render a PDF but never a diff.
--
-- WHY ON THIS TABLE RATHER THAN application_attempts. The prepared-document
-- reuse path (resolveSubmissionResumeUnchecked -> loadPreparedDocument) returns an
-- existing row WITHOUT regenerating anything, so text derived at read time could
-- never be produced on that path - the content it would be derived from is gone.
-- Storing it on the document row means the answer travels with the file it
-- describes, and the review screen reads one row instead of reconstructing it.
--
-- WHY base_text LIVES ON THE TAILORED ROW. It is the provenance of this
-- tailoring - what this document was rewritten from - not a property of the
-- candidate's current upload, which may have been replaced since. Recording it
-- here is what keeps the review screen showing the comparison that was actually
-- approved even after the candidate uploads a newer resume.

alter table public.resume_documents
  add column base_text text;

alter table public.resume_documents
  add column tailored_text text;

-- THE PAIR IS ATOMIC. A diff needs both sides, so one column without the other is
-- not a smaller answer - it is an unrenderable one. The writer records both or
-- neither, and this refuses the half state rather than letting it reach a reader
-- that would have to guess.
alter table public.resume_documents
  add constraint resume_documents_text_pair_check
  check ((base_text is null) = (tailored_text is null));

comment on column public.resume_documents.base_text is
  'Plain text of the resume this document was tailored FROM. Set only on a kind = tailored row, and only together with tailored_text. NULL means the pair was not recorded, most often because the base file could not be read - which must never block a submission.';

comment on column public.resume_documents.tailored_text is
  'Plain text of THIS tailored document, mirroring what renderTailoredResumeHtml puts into the PDF. Set only together with base_text. Read by the review screen to render the word diff; never sent to an ATS.';

-- NO NEW GRANTS, stated rather than assumed:
--
--   * authenticated already holds table-wide SELECT, so a candidate reaches the
--     text of their own documents through the existing select_own policy. It is
--     their resume, and the same bytes are already readable to them as the PDF in
--     the private 'resumes' bucket. This adds a representation, not a disclosure.
--
--   * authenticated holds COLUMN-SCOPED INSERT - five columns, from
--     20260929120000_resume_documents_parse_status.sql - so these two columns
--     cannot be named in a candidate INSERT at all. They take their NULL default,
--     which the pair constraint accepts, and a candidate cannot attach text to
--     their own row or forge it.
--
--   * service_role holds table-wide grants, and a table-level privilege covers
--     columns added later, so the generation path can write them with no change.
--     (Asserted by deploy/preflight-schema.sh Check A/B running against the same
--     database this was verified on.)
