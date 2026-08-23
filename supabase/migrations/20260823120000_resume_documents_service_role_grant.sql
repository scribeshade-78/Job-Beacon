-- The original 20260813184932_resume_documents.sql migration granted
-- select/insert/delete to authenticated only. service_role SELECT was
-- always needed for MP-F1's extraction endpoint ownership check
-- (server/resumes/extractFacts.ts queries resume_documents via the
-- service-role client, bypassing RLS by design since extraction is
-- server-triggered, not user-request-scoped), but that grant was missing
-- from day one. Surfaced by the 2026-08-24 live smoke test (a real
-- PostgREST 42501 permission-denied error), not by unit tests — those mock
-- the Supabase client entirely and never touch real grants.
grant select on public.resume_documents to service_role;
