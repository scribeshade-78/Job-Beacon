# R1 + R2 Completion Report — Verified Candidate Foundation & Vacancy Discovery Foundation

Recorded: 2026-08-16
Branch: `mp2a-candidate-ownership-rls`
Verified HEAD at time of writing (before this report's own commit): `569707bd4337f432844653eca648e2bc030f485e`

This document follows the same fact/claim separation as `docs/PHASE_0_COMPLETION.md`: only repository-verified state and commands actually executed in this session are reported as fact.

## 1. Scope covered by this report

- **R1 — Identity, Verified Profile & Role Authorization** (roadmap Phase 1): candidate session/MFA, resume upload/confirmation, candidate profile, exclusions, automation authorization, and the row-level-security policies that scope all of it to the owning candidate.
- **R2 — Vacancy Discovery Foundation** (roadmap Phase 2): source-policy registry, ATS/aggregator adapters (Greenhouse, Lever, Adzuna, USAJobs), vacancy normalization/fingerprinting, ingestion worker, canonical vacancy schema, and the RLS policies governing vacancy/source data.

## 2. Commits in scope

| Commit | Message | Merged to `origin/main`? |
|---|---|---|
| `3f2a464` | feat(db): add candidate profile ownership and RLS | Yes — via PR #3 (`0a72975`) |
| `2f56bb1` | feat(r1): complete verified candidate foundation | Yes — via PR #3 (`0a72975`) |
| `569707b` | feat(r2): vacancy discovery foundation | No — local to `mp2a-candidate-ownership-rls` prior to this mini-phase; this report's own commit and the subsequent push/PR bring it into review |

PR history confirmed via `gh pr list --state all`: #1 (`phase-1a-supabase-foundation`, merged), #2 (`phase-1b-auth-session`, merged), #3 (`mp2a-candidate-ownership-rls`, merged, contains `3f2a464` + `2f56bb1`). No PR existed for `569707b` prior to this mini-phase.

## 3. File scope (from `git show --stat` on each commit)

**R1 (`3f2a464` + `2f56bb1`):** `client/src/App.tsx`, `client/src/lib/{profile,automationAuthorization,exclusions,mfa,resume,session}.ts` + matching `*.test.ts`, `supabase/config.toml`, migrations `20260812231617_candidate_profiles.sql`, `20260813184932_resume_documents.sql`, `20260813184939_candidate_exclusions.sql`, `20260813184945_automation_authorizations.sql`, and pgTAP suites `candidate_profiles.test.sql`, `resume_documents.test.sql`, `candidate_exclusions.test.sql`, `automation_authorizations.test.sql`.

**R2 (`569707b`):** `.env.example`; `server/ingestion/adapters/{adzuna,greenhouse,lever,usajobs}.ts` + tests; `server/ingestion/{fingerprint,ingest,worker,types}.ts` + tests; `server/supabaseServiceRole.ts` + test; migrations `20260813205320_source_policies.sql`, `20260813205324_companies.sql`, `20260813205329_vacancy_sources.sql`, `20260813205333_vacancies.sql`, `20260813205337_vacancy_versions.sql`, `20260813205341_vacancy_source_records.sql`, `20260813205345_vacancy_fingerprints.sql`, `20260813205354_ingestion_jobs.sql`; pgTAP suites `ingestion_worker.test.sql` and `vacancy_discovery_rls.test.sql`.

## 4. Exact commands and verified results

All commands run from the repository root at HEAD `569707b`.

```
$ npm run typecheck
> jobbeacon@0.0.0 typecheck
> tsc --noEmit && tsc -p tsconfig.server.json --noEmit
(no output — successful)
Exit code: 0
```

```
$ npm test
> jobbeacon@0.0.0 test
> vitest run

 Test Files  19 passed (19)
      Tests  148 passed (148)
Exit code: 0
```

```
$ npx supabase test db
Connecting to local database...
automation_authorizations.test.sql .. ok
candidate_exclusions.test.sql ....... ok
candidate_profiles.test.sql ......... ok
ingestion_worker.test.sql ........... ok
resume_documents.test.sql ........... ok
vacancy_discovery_rls.test.sql ...... ok
All tests successful.
Files=6, Tests=155
Result: PASS
```

`supabase test db` resets the local database and reapplies every migration from scratch before running the pgTAP suites, so this run is also evidence that the full migration chain applies cleanly in order on a fresh Postgres instance — not merely that tests pass against pre-existing state.

```
$ npx supabase migration list --local
```
Confirmed all 13 migration files applied (local timestamp = remote timestamp for each), from `20260812231617_candidate_profiles` (R1) through `20260813205354_ingestion_jobs` (R2, the final file introduced by `569707b`). No gaps, no failed migrations.

**Environment used:** Supabase CLI via `npx supabase` (v2.114.0) — not installed globally, no install was required. Local Supabase stack ran via Docker Desktop (v29.7.2), containers already running for this project (`supabase_db_JobBeacon` and related services) at the start of this mini-phase; no new stack was started.

## 5. Remaining limitations and approved deferrals

- **CI/CD**: still not configured (no `.github/` directory, no workflow YAML). Same approved deferral as recorded in `PHASE_0_COMPLETION.md` §8 — unchanged status, not a regression introduced by R1/R2.
- **Production deployment**: still not configured; no Dockerfile/deploy script targeting a production host exists in the repository. Approved deferral, unchanged.
- **R1/R2 database verification was performed only against the local Docker Supabase stack**, not against a staging or production Postgres instance. No staging/production environment was contacted in this mini-phase.
- **Browser/UI QA**: not performed for R1 or R2 candidate-facing flows in this mini-phase (verification here covers typecheck, unit tests, and pgTAP database tests only).
- **PRD v3.0 founder approval**: still outstanding, per `CURRENT_BASELINE.md` §5 — unchanged, not a blocker to closing this mini-phase.

## 6. Definition of Done

- [x] R1 scope (identity, verified profile, role authorization, RLS) traced to commits `3f2a464` and `2f56bb1`, confirmed merged to `origin/main` via PR #3.
- [x] R2 scope (vacancy discovery foundation, ATS adapters, ingestion worker, vacancy schema) traced to commit `569707b`.
- [x] `npm run typecheck` passed (exit 0) against HEAD `569707b`.
- [x] `npm test` passed — 19 files, 148 tests (exit 0) against HEAD `569707b`.
- [x] `npx supabase test db` passed — 6 pgTAP suites, 155 assertions, covering both R1 and R2 RLS/table behavior, against a freshly reset local Postgres instance.
- [x] All 13 migrations (R1 + R2) confirmed applied via `npx supabase migration list --local`.
- [ ] Local `main` sync, branch push, and PR #4 — tracked as the immediate next steps of this same mini-phase, executed after this report is committed.
- [ ] Staging/production-equivalent database verification — outstanding, not attempted this mini-phase.
- [ ] R1/R2 browser/UI QA — outstanding, not attempted this mini-phase.

## 7. Skills/tools actually used

- `jobbeacon-development` — invoked via the `Skill` tool successfully this session (unlike the Phase 0 session, where it could not be loaded due to a filesystem defect that has since been fixed).
- Supabase CLI (`npx supabase test db`, `npx supabase status`, `npx supabase migration list --local`) — used directly for database verification.
- `gh` CLI — used read-only (`gh pr list`, `gh auth status`) to confirm PR history prior to this report.
