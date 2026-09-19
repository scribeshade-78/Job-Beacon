-- Which optimization level produced a tailored resume.
--
-- WHY THIS IS NEEDED FOR THE REVIEW GATE, not just nice to have.
--
-- Task U changes the flow so a tailored resume is generated ONCE, when the
-- candidate approves a held attempt, and the dispatcher then reuses that
-- document instead of regenerating it. Before this, the level could be read
-- fresh at dispatch time and would usually still be right.
--
-- It is not right after reuse. The candidate can change their preference
-- between approving an application and the worker picking it up, and the
-- reused file was produced under the OLD setting. Reporting the current
-- preference in the submission evidence would then describe a document that
-- does not exist — evidence claiming "aggressive" about a file written under
-- "honest". That is exactly the kind of plausible-but-false record this
-- codebase refuses elsewhere, so the producing level is stored on the document
-- itself, where it cannot drift from the file it describes.
--
-- NULL for kind='uploaded' rows: a file the candidate provided was not
-- produced at any optimization level, and defaulting those to 'off' would
-- assert something untrue about them. The CHECK therefore allows NULL
-- alongside the three real values.
alter table public.resume_documents
  add column optimization_level text;

alter table public.resume_documents
  add constraint resume_documents_optimization_level_check
  check (
    optimization_level is null
    or optimization_level in ('off', 'honest', 'aggressive')
  );

comment on column public.resume_documents.optimization_level is
  'The resume_optimization_level in force when a kind=tailored document was generated. NULL for kind=uploaded, which no optimization level produced.';
