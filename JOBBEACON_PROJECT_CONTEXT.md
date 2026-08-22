# JobBeacon — Current Repository State

Snapshot as of the MP-F1 mini-phase (2026-08-23), verified directly against the repository (not carried from any prior document). Supersedes any earlier "35 tables" figure stated in this session — that was a manual-count error; the actual, `wc -l`-verified count is **38**.

## Stack (verified)

React (Vite) frontend, Express API, Supabase (Postgres + Auth + Storage), no ORM currently in use for query building (raw `@supabase/supabase-js` calls throughout), additive SQL migrations under `supabase/migrations/`. Client-side routing added in MP-UI2 via `wouter` (hash-based location — the Express static server has no SPA fallback route for browser-history mode, and touching `server/` was out of scope for that phase). `client/src/App.tsx` now only owns auth/session/profile state and the router; the 10 panels live as standalone components under `client/src/panels/`, rendered inside page components under `client/src/pages/` and a shared `AppShell` (sidebar + topbar).

## Express API routes (5 total — `server/index.ts`)

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | none |
| GET | `/api/me` | bearer token |
| POST | `/api/vacancies/:vacancyId/reports` | bearer token |
| GET | `/api/moderation/queue` | bearer token + moderator |
| POST | `/api/moderation/cases/:caseId/decisions` | bearer token + moderator |
| POST | `/api/resumes/:id/extract` | bearer token (MP-F1) |

Everything else (applications, resumes, mailbox, automation authorization, exclusions, MFA, companies, salary benchmarks, action-required events, reading back extracted facts) is read/written directly by the browser via the Supabase client library, scoped by RLS — not through Express. The extraction *write* is the one exception: `extracted_facts` grants `INSERT` only to `service_role` (no request-scoped RLS client exists anywhere in this server — every route uses the service-role client), so it has to go through Express; ownership of the resume being extracted is verified in application code, not RLS.

## Client screens (10 routed pages + shell, MP-UI2)

Routes (hash-based, e.g. `/#/resumes`): Overview `/`, Profile `/profile`, Resumes `/resumes`, Target Roles `/target-roles`, Opportunities `/opportunities`, Applications `/applications`, Responses `/responses`, Action Required `/action-required`, Company Intelligence `/companies`, Security `/security`. Same 10 panels as MP-UI1 (ApplicationsPanel, ActionRequiredPanel, MailboxPanel, MessagesPanel, ResumesPanel, ExclusionsPanel, AutomationPanel, SecurityPanel, CompaniesPanel, SalaryBenchmarksPanel) now render inside these pages — Responses hosts Mailbox+Messages, Company Intelligence hosts Companies+SalaryBenchmarks, Overview hosts a real AutomationPanel plus an unchanged ActionRequiredPanel widget alongside honest (non-fabricated) empty-state stats and a recent-applications placeholder. Target Roles and Opportunities are honest empty-state pages — no panel exists for either yet. Plus three pre-signed-in states: loading, email-confirmation-pending, and the auth (log in / sign up) card — re-skinned to the iOS design language in MP-UI1.

**No Opportunities/job-browse screen, no role-selection UI, and no resume fact-confirmation UI exist anywhere in the client** (both now have labeled empty-state pages instead of being entirely absent from navigation).

## PRD journey steps — backend and UI status

| Step | Backend | UI |
|---|---|---|
| Resume upload + private storage | Complete | Complete (ResumesPanel) |
| Resume extraction (MP-F1) | Complete — `POST /api/resumes/:id/extract`: ownership check, server-side download, `pdf-parse`/`mammoth` text extraction, OpenAI structured-output extraction (v0 vocabulary: `full_name`/`email`/`phone`/`location`/`current_title`/`years_of_experience`/`most_recent_employer` scalar, `skill`/`education`/`experience` repeatable), schema-validated before any insert, `extraction_model`/`extraction_prompt_version` recorded on every row | Complete — "Extract facts" button + read-only facts preview in ResumesPanel |
| Fact confirmation (MP-F2) | **Not implemented** — `fact_confirmations` table exists (schema+RLS only); zero writers still | None |
| Role suggestions + selection | **Not implemented** — `candidate_selected_roles` table exists (schema+RLS only); zero writers anywhere in the repo | None |
| Automation authorization | Complete, enforced at 3 points (claim-time, submission-time, resolve-time) | Complete (AutomationPanel) |
| Evidence / action-required views | Action-required: read surface exists (ActionRequiredPanel, unresolved events only). Evidence: RLS-readable, **no viewer exists** | Partial |
| Application planning (`planApplication`) / worker (`runOneApplicationAttempt`) | Built and unit-tested | **No UI trigger, no route, no cron/worker entrypoint anywhere** — unreachable by a real candidate today |

## Database tables (38, from migrations)

`action_required_events`, `application_attempts`, `application_evidence`, `application_plans`, `automation_authorizations`, `candidate_action_items`, `candidate_exclusions`, `candidate_profiles`, `candidate_selected_roles`, `companies`, `company_legal_entities`, `company_profiles`, `company_registry_lookup_jobs`, `company_registry_records`, `extracted_facts`, `fact_confirmations`, `ingestion_jobs`, `interviews`, `mailbox_connections`, `messages`, `moderation_cases`, `moderation_decisions`, `response_classifications`, `resume_documents`, `salary_benchmarks`, `source_health_events`, `source_policies`, `user_roles`, `vacancies`, `vacancy_appeals`, `vacancy_evidence`, `vacancy_fingerprints`, `vacancy_flags`, `vacancy_reports`, `vacancy_source_records`, `vacancy_sources`, `vacancy_trust_scores`, `vacancy_versions`.

## The core gap

The R4/R7 application engine (eligibility gates, planning, worker lifecycle, retry/dead-letter, authorization-withdrawal safety net, action-required pause/resume) is real, tested, and correct — but nothing in the client or the Express routes ever calls `planApplication`, so no real candidate can create an `application_plan`/`application_attempt` today. `ApplicationsPanel`/`ActionRequiredPanel` are fully wired for *reading* but have nothing real to show until that entry point exists. Real ATS submission is additionally blocked on an external employer relationship (see prior session's Greenhouse integration-readiness analysis) — `resolveApplicationAdapter` has no real per-source case, `source_policies.automated_application_allowed` is `false` for every row, and no `vacancy_sources` row targets a real employer board yet.

**MP-F1 does not by itself unblock `eligibilityGate.ts`'s `verified_facts` gate or `resumeGenerator.ts`'s `generateResumePayload`** — both require a *confirmed* fact (a `fact_confirmations` row with `status = 'confirmed'`), and `fact_confirmations` still has zero writers (that's MP-F2). A candidate can now have real `extracted_facts` rows after MP-F1, but every one of them is still unconfirmed, so those two gates behave exactly as before until MP-F2 lands.

## Resume fact extraction (MP-F1)

`POST /api/resumes/:id/extract` (`server/index.ts`, logic in `server/resumes/`): `requireAuth` → per-candidate rate limit (`express-rate-limit`, 5 requests / 15 min, keyed by `request.user.id`) → ownership check against `resume_documents` (404 for both "doesn't exist" and "not yours" — never distinguishes) → server-side Storage download → `pdf-parse`/`mammoth` text extraction (`textExtraction.ts`) → OpenAI structured-output extraction (`openaiExtraction.ts`, strict JSON schema + an independent manual validator — never trusts the API response blindly) → `extractFacts.ts` flattens the validated result into `extracted_facts` rows and inserts them in one batch (zero rows ever inserted on any failure, including a malformed-output rejection).

v0 fact vocabulary (code-owned, no PRD taxonomy exists): scalar `full_name`/`email`/`phone`/`location`/`current_title`/`years_of_experience`/`most_recent_employer` (0 or 1 row each); repeatable `skill`/`education`/`experience` (0..N rows each, education/experience flattened to a single string per entry since the table has no way to group multi-field entries). "Never guess": a field the model couldn't determine gets **no row at all**, never a placeholder or a null `fact_value` (the column is `NOT NULL`).

Schema: `20260823090000_extracted_facts_provenance.sql` added `extraction_model`/`extraction_prompt_version` (both `NOT NULL`, no default — safe because the table was verified empty, zero writers, before this migration). Both existing pgTAP fixtures that insert into `extracted_facts` (`extracted_facts_rls.test.sql`, `fact_confirmations_rls.test.sql`) were updated to supply them; the full `supabase test db` suite (29 files, 448 tests) passes against a fresh `supabase db reset` with this migration applied.

New dependencies: `openai`, `pdf-parse` (v2 API — `new PDFParse({data}).getText()`, must `.destroy()`), `mammoth`, `express-rate-limit`. New env vars: `OPENAI_API_KEY` (required, server-only), `OPENAI_MODEL` (optional, defaults to `DEFAULT_OPENAI_MODEL` in `openaiExtraction.ts`).

**No live OpenAI call has been made** — this environment has no `OPENAI_API_KEY` and no outbound network access. Everything is built against an injectable `Pick<OpenAI, "chat">` client (same DI pattern as `serviceClient` in `server/index.ts`) and tested with a mocked client. Real cost/latency/quality against the actual API is unverified until a manual smoke test is run with a real key.

## UI design system (MP-UI1 + MP-UI2)

iOS-aesthetic design tokens (Tailwind v4, CSS-first `@theme`), owned-code core components (`client/src/components/ui/`: Button, Card, Input, Label, Badge, StatusBadge, Avatar, Dialog, DropdownMenu, Toast, EmptyState), and re-skinned auth screens (`AuthCard`, `LoadingScreen`, `ConfirmationPendingScreen`) from MP-UI1. MP-UI2 added: `wouter` router + `AppShell` (fixed 260px desktop sidebar, 64px frosted sticky topbar, mobile hamburger drawer), `client/src/pages/` (10 route pages), extracted `client/src/panels/` (the 10 panels, moved out of `App.tsx` with logic unchanged, re-skinned onto Card/Button/StatusBadge), and 3 new `StatusBadge` variants (`automation_active/paused/stopped`) for the Automation card. `lucide-react` supplies all icons (no icon-font CDN). The legacy `.app-shell`/`.foundation-card`/`.eyebrow` CSS classes (dead once the last panel consumers were re-shelled) were removed from `styles.css`.
