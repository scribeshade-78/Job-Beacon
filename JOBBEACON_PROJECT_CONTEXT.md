# JobBeacon — Current Repository State

Snapshot as of the MP-UI1 mini-phase (2026-08-22), verified directly against the repository (not carried from any prior document). Supersedes any earlier "35 tables" figure stated in this session — that was a manual-count error; the actual, `wc -l`-verified count is **38**.

## Stack (verified)

React (Vite) frontend, Express API, Supabase (Postgres + Auth + Storage), no ORM currently in use for query building (raw `@supabase/supabase-js` calls throughout), additive SQL migrations under `supabase/migrations/`. No client-side router — `client/src/App.tsx` is a single 900+ line file that conditionally renders panels based on auth state.

## Express API routes (5 total — `server/index.ts`)

| Method | Path | Auth |
|---|---|---|
| GET | `/api/health` | none |
| GET | `/api/me` | bearer token |
| POST | `/api/vacancies/:vacancyId/reports` | bearer token |
| GET | `/api/moderation/queue` | bearer token + moderator |
| POST | `/api/moderation/cases/:caseId/decisions` | bearer token + moderator |

Everything else (applications, resumes, mailbox, automation authorization, exclusions, MFA, companies, salary benchmarks, action-required events) is read/written directly by the browser via the Supabase client library, scoped by RLS — not through Express.

## Client screens (10 panels, one signed-in shell — no router)

ApplicationsPanel, ActionRequiredPanel, MailboxPanel, MessagesPanel, ResumesPanel, ExclusionsPanel, AutomationPanel, SecurityPanel, CompaniesPanel, SalaryBenchmarksPanel. Plus three pre-signed-in states: loading, email-confirmation-pending, and the auth (log in / sign up) card — re-skinned to the iOS design language in MP-UI1.

**No Opportunities/job-browse screen, no role-selection UI, and no resume fact-confirmation UI exist anywhere in the client.**

## PRD journey steps — backend and UI status

| Step | Backend | UI |
|---|---|---|
| Resume upload + private storage | Complete | Complete (ResumesPanel) |
| Resume extraction + fact confirmation | **Not implemented** — `extracted_facts`/`fact_confirmations` tables exist (schema+RLS only); zero writers anywhere in the repo, only two consumer files read them | None |
| Role suggestions + selection | **Not implemented** — `candidate_selected_roles` table exists (schema+RLS only); zero writers anywhere in the repo | None |
| Automation authorization | Complete, enforced at 3 points (claim-time, submission-time, resolve-time) | Complete (AutomationPanel) |
| Evidence / action-required views | Action-required: read surface exists (ActionRequiredPanel, unresolved events only). Evidence: RLS-readable, **no viewer exists** | Partial |
| Application planning (`planApplication`) / worker (`runOneApplicationAttempt`) | Built and unit-tested | **No UI trigger, no route, no cron/worker entrypoint anywhere** — unreachable by a real candidate today |

## Database tables (38, from migrations)

`action_required_events`, `application_attempts`, `application_evidence`, `application_plans`, `automation_authorizations`, `candidate_action_items`, `candidate_exclusions`, `candidate_profiles`, `candidate_selected_roles`, `companies`, `company_legal_entities`, `company_profiles`, `company_registry_lookup_jobs`, `company_registry_records`, `extracted_facts`, `fact_confirmations`, `ingestion_jobs`, `interviews`, `mailbox_connections`, `messages`, `moderation_cases`, `moderation_decisions`, `response_classifications`, `resume_documents`, `salary_benchmarks`, `source_health_events`, `source_policies`, `user_roles`, `vacancies`, `vacancy_appeals`, `vacancy_evidence`, `vacancy_fingerprints`, `vacancy_flags`, `vacancy_reports`, `vacancy_source_records`, `vacancy_sources`, `vacancy_trust_scores`, `vacancy_versions`.

## The core gap

The R4/R7 application engine (eligibility gates, planning, worker lifecycle, retry/dead-letter, authorization-withdrawal safety net, action-required pause/resume) is real, tested, and correct — but nothing in the client or the Express routes ever calls `planApplication`, so no real candidate can create an `application_plan`/`application_attempt` today. `ApplicationsPanel`/`ActionRequiredPanel` are fully wired for *reading* but have nothing real to show until that entry point exists. Real ATS submission is additionally blocked on an external employer relationship (see prior session's Greenhouse integration-readiness analysis) — `resolveApplicationAdapter` has no real per-source case, `source_policies.automated_application_allowed` is `false` for every row, and no `vacancy_sources` row targets a real employer board yet.

## UI design system (MP-UI1, this mini-phase)

iOS-aesthetic design tokens (Tailwind v4, CSS-first `@theme`), owned-code core components (`client/src/components/ui/`: Button, Card, Input, Label, Badge, StatusBadge, Avatar, Dialog, DropdownMenu, Toast), and re-skinned auth screens (`AuthCard`, `LoadingScreen`, `ConfirmationPendingScreen`). Router + app-shell + panel migration to the new components is deferred to MP-UI2 (not started).
