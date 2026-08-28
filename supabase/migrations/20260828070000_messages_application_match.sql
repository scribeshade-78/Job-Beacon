-- Response Intelligence Phase 3 — application matching. Adds the
-- explainability record for how a message got linked to an application.
--
-- messages.application_attempt_id already exists (nullable FK, since the
-- original 20260820140010_messages.sql) and service_role already has
-- UPDATE on messages, so the matcher needs no new column to write the
-- link itself — only this one to record *why*. A trust/link decision must
-- be explainable through stable reason codes (product invariant); a bare
-- application_attempt_id can't answer "why is this message on that
-- application?" later.
--
-- Generic JSONB, same "no invented typed shape" precedent as
-- gate_results / raw_extraction: the matcher owns the shape
-- ({ confidence, reasons: text[], matched_at }); a schema change here
-- every time a heuristic is added or renamed would be churn.
--
-- No RLS/grant change: authenticated already has table-level SELECT on
-- messages (candidate seeing why their own message was linked is fine),
-- service_role already has full DML. Left NULL for every message the
-- matcher did not auto-link (review-band and no-match messages keep it
-- NULL, same as application_attempt_id).

alter table public.messages
  add column application_match jsonb;
