-- Upsert target for company_legal_entities (R5.6; needed for
-- ON CONFLICT-based upserts in the MCA registry population pipeline).
--
-- Missed in the original R5.4 migration: without this constraint,
-- re-running a registry lookup for the same company/jurisdiction/
-- registry identifier would insert a duplicate row every time rather
-- than updating the existing one (e.g. a status or capital change on
-- re-lookup). (company_id, jurisdiction, registry_identifier) together
-- identify "this company's entry in this specific registry" — the same
-- identifier could theoretically recur under a different jurisdiction in
-- a degenerate case, so all three columns are part of the key, not
-- registry_identifier alone.
alter table public.company_legal_entities
  add constraint company_legal_entities_company_jurisdiction_identifier_key
  unique (company_id, jurisdiction, registry_identifier);
