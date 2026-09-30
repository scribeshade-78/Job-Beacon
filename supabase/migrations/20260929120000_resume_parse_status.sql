-- Resume parse status (Phase 0 Task 2).
--
-- WHY THIS EXISTS. Readiness must not be inferred from a resume row existing.
-- "A document was uploaded" and "we successfully read it" are different facts,
-- and the second is the one that lets matching, tailoring and submission rely on
-- the file's contents. Before this migration no column, table or run record
-- carried that distinction anywhere in the schema, so every consumer either
-- assumed success or fell back to counting extracted_facts rows — which cannot
-- tell "parsed and found nothing" apart from "never parsed".
--
-- STATUS MEANING
--   uploaded  the document exists; parsing has not been confirmed
--   parsing   extraction is currently running
--   parsed    extraction completed successfully
--   failed    an extraction attempt failed
--
-- WHY COLUMNS HERE RATHER THAN A SEPARATE RUN TABLE. Extraction is a single
-- service-role call (server/resumes/extractFacts.ts) reached only from
-- POST /api/resumes/:id/extract, and "the current parse state of this document"
-- is a 1:1 fact about the document — a run table would add a join and a
-- "which run is current" rule to model something that has exactly one current
-- answer. The history that matters (when parsing started, when it finished) is
-- captured in the timestamps below.
--
-- HOW A CANDIDATE IS PREVENTED FROM FORGING 'parsed'. This is the load-bearing
-- part of the choice, so it is stated rather than assumed:
--
--   1. authenticated has NO UPDATE grant on this table and there is no UPDATE
--      policy (20260813184932_resume_documents.sql grants select/insert/delete
--      only), so a parse_status that is already stored cannot be changed by a
--      candidate at all.
--
--   2. The INSERT grant becomes COLUMN-SCOPED below. Without that, a candidate
--      could simply insert a new row naming parse_status = 'parsed', because
--      insert_own lets them insert their own documents. Granting only the five
--      columns the upload flow actually writes leaves parse_status to take its
--      DEFAULT of 'uploaded', and an INSERT that names it fails with 42501
--      before RLS is even consulted.
--
--      The five columns are exactly what client/src/lib/resume.ts's uploadResume
--      inserts (candidate_id, storage_path, original_filename, mime_type,
--      byte_size); kind already takes its default and is deliberately not
--      grantable, so a candidate cannot create a 'tailored' row either.
--
--   3. Only service_role (which bypasses RLS and already holds table-wide
--      grants) writes a terminal state, and it does so from the extraction path.
--
-- Column-scoping the grant follows this repository's existing precedent:
-- 20260917140000 grants UPDATE on candidate_profiles for exactly two columns for
-- the same "grant back only what this slice needs" reason.

alter table public.resume_documents
  add column parse_status text not null default 'uploaded';

alter table public.resume_documents
  add constraint resume_documents_parse_status_check
  check (parse_status in ('uploaded', 'parsing', 'parsed', 'failed'));

-- A safe, candidate-facing failure code. Never a stack trace, SQL error, storage
-- path, provider response or model output — the extraction path maps every
-- failure to one of a small set of codes before writing here.
alter table public.resume_documents
  add column parse_error text;

alter table public.resume_documents
  add column parse_started_at timestamptz;

-- Set only on success, and asserted by the constraint below: a document cannot
-- claim to have parsed without saying when, so a half-written success is
-- rejected by the database rather than rendered as ready.
alter table public.resume_documents
  add column parsed_at timestamptz;

alter table public.resume_documents
  add column parse_updated_at timestamptz not null default now();

alter table public.resume_documents
  add constraint resume_documents_parsed_at_check
  check (parse_status <> 'parsed' or parsed_at is not null);

comment on column public.resume_documents.parse_status is
  'Candidate-visible parse state: uploaded | parsing | parsed | failed. Written only by the service-role extraction path; a candidate holds no UPDATE grant and cannot INSERT this column, so it cannot be forged.';

comment on column public.resume_documents.parse_error is
  'Safe machine-readable failure code when parse_status = failed. Sanitized before writing: no stack traces, storage paths, SQL errors or provider output.';

comment on column public.resume_documents.parse_started_at is
  'When the current parsing attempt began.';

comment on column public.resume_documents.parsed_at is
  'When extraction last completed successfully. Non-null whenever parse_status = parsed.';

comment on column public.resume_documents.parse_updated_at is
  'When parse_status last changed. Maintained by the extraction path, not by a trigger, because it is the only writer.';

-- ---------------------------------------------------------------------------
-- Least privilege on INSERT: the forge-proofing step.
--
-- Replaces the table-wide INSERT grant from 20260813184932. The upload flow
-- inserts exactly these five columns, so it is unaffected; anything else naming
-- parse_status (or kind) is now refused outright.
-- ---------------------------------------------------------------------------
revoke insert on public.resume_documents from authenticated;

grant insert (candidate_id, storage_path, original_filename, mime_type, byte_size)
  on public.resume_documents to authenticated;

-- ---------------------------------------------------------------------------
-- BACKFILL — CONSERVATIVE AND IDEMPOTENT.
--
-- A document is marked parsed ONLY where a reliable, verified extraction record
-- exists. extracted_facts.source_document_id is a NOT NULL foreign key onto
-- resume_documents(id) (20260819100000_extracted_facts.sql), so the link is
-- exact rather than heuristic: it cannot be inferred from the candidate, a
-- filename or an upload time. No linked fact means the document stays
-- 'uploaded', which is the only defensible reading of "we do not know" —
-- in particular it is NOT marked 'failed', because nothing failed.
--
-- Idempotent by construction: the WHERE clause is a state predicate, not a
-- one-shot condition, so re-running sets the same rows to the same values.
-- ---------------------------------------------------------------------------
with evidence as (
  select
    source_document_id as document_id,
    max(created_at) as last_evidence_at
  from public.extracted_facts
  group by source_document_id
)
update public.resume_documents rd
set
  parse_status = 'parsed',
  -- The newest reliable linked-fact timestamp for this exact document, which is
  -- the only honest answer to "when did we last read this successfully".
  parsed_at = evidence.last_evidence_at,
  parse_error = null,
  parse_updated_at = now()
from evidence
where rd.id = evidence.document_id
  and rd.parse_status <> 'parsed';

-- ---------------------------------------------------------------------------
-- VALIDATION QUERIES — run after applying, none executed here.
--
-- 1. Status distribution (expect only 'uploaded' and 'parsed' right after this
--    migration; 'parsing' and 'failed' can only appear once extraction runs):
--
--      select parse_status, count(*) from public.resume_documents group by 1 order by 1;
--
-- 2. The parsed_at invariant holds:
--
--      select count(*) from public.resume_documents
--      where parse_status = 'parsed' and parsed_at is null;   -- expect 0
--
-- 3. No document was marked parsed without linked evidence:
--
--      select count(*) from public.resume_documents rd
--      where rd.parse_status = 'parsed'
--        and not exists (select 1 from public.extracted_facts f
--                        where f.source_document_id = rd.id);   -- expect 0
--
-- 4. Nothing was marked failed by the backfill:
--
--      select count(*) from public.resume_documents
--      where parse_status = 'failed';   -- expect 0
--
-- 5. The INSERT grant is column-scoped (expect the five upload columns only,
--    and no parse_status):
--
--      select column_name from information_schema.column_privileges
--      where table_name = 'resume_documents' and grantee = 'authenticated'
--        and privilege_type = 'INSERT' order by column_name;
--
-- 6. Re-running the backfill is a no-op (statement reports 0 rows updated).
--
-- ROLLBACK / RECOVERY
--   The backfill is reversible without data loss because it only ever moved
--   rows 'uploaded' -> 'parsed' using evidence that still exists:
--
--      update public.resume_documents set parse_status = 'uploaded', parsed_at = null
--      where id in (select source_document_id from public.extracted_facts);
--
--   To remove the feature entirely, restore the table-wide INSERT grant first,
--   then drop the constraint and columns:
--
--      grant insert on public.resume_documents to authenticated;
--      alter table public.resume_documents drop constraint resume_documents_parsed_at_check;
--      alter table public.resume_documents drop constraint resume_documents_parse_status_check;
--      alter table public.resume_documents
--        drop column parse_status, drop column parse_error, drop column parse_started_at,
--        drop column parsed_at, drop column parse_updated_at;
