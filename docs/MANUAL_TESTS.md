# JobBeacon — Manual Test Checklist

## MP-F1 + MP-F2 Combined Smoke Test (DEFERRED — MUST run before either phase is considered production-verified)

Founder decision: MP-F1 committed without a live smoke test (unit+pgTAP all green; live OpenAI/Storage/E2E untested), and that test was deferred to MP-F2 start. MP-F2 (fact confirmation UI) is now implemented on top of the same unverified extraction path, so this is a single combined smoke test covering both: upload → extract → pending → confirm → correct → reject → verify.

### API-level run 1 — 2026-08-24 (BLOCKED — see below; not a pass)

Ran as an API-level substitute for the browser flow (curl + REST against a local `supabase start`/`db reset` stack, `npm run dev` server). Blocked before extraction could run — real environment misconfiguration, not a code bug. Full detail in this session's report. Browser-only items (UI clicks, badges, F12 console) remain unchecked below and still need the actual UI pass.

### Pre-checks

- [x] Storage container running: was stopped, `supabase start` → up (`supabase status` confirms `storage-api` no longer in the stopped list)
- [ ] `.env` has `OPENAI_API_KEY` set — **NO.** `.env` has `OPEN_AI_API_KEY` (extra underscore — does not match the `OPENAI_API_KEY` the server code actually reads in `server/resumes/openaiClient.ts`). Not independently confirmable whether the value itself is a real key, since the name doesn't match what's read.
- [ ] Servers restart after .env change — not exercised; blocked by a separate, more fundamental gap below

**Additional gap found, not on the original checklist:** `.env` has no `SUPABASE_SERVICE_ROLE_KEY` entry at all. `server/supabaseServiceRole.ts` requires it for every service-role operation — this is what actually broke the run (see Errors below), before the OpenAI key mismatch was even reached.

### Test steps

**Upload → extract**
- [x] Resume upload (PDF/DOCX) — done at the API level (Storage REST + `resume_documents` insert as the test user), not through the browser UI. Verified via `psql`.
- [x] "Extract facts" click → wait — done as `POST /api/resumes/:id/extract` with the test user's bearer token
- [ ] Facts preview shows real facts — **not reached, endpoint returned HTTP 500**
- [x] Latency noted — 0.29s (to the 500 failure, not a real extraction latency)
- [ ] F12 console — no unexpected errors — not applicable, no browser involved
- [ ] Rate limit 6th click/15min → 429 (by design) — not tested, blocked upstream

**Pending state**
- [ ] Every extracted fact shows a "Pending review" badge — not reached

**Confirm / Correct / Reject / Un-confirm**
- [ ] All four — not reached

**Re-extraction (known limitation)**
- [ ] Not tested this run

### Results record

- Extraction quality: N/A — extraction never ran (blocked at the service-role config check, before OpenAI was ever called)
- Latency: 0.29s to the 500 error (not representative of real extraction latency)
- Errors: `POST /api/resumes/{id}/extract` → HTTP 500, body `{"error":"Missing Supabase service-role configuration: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."}`. Root cause: `.env` has no `SUPABASE_SERVICE_ROLE_KEY` at all, so `readSupabaseServiceRoleConfig()` (`server/supabaseServiceRole.ts`) throws before any Supabase or OpenAI call is attempted. A second, separate gap (not yet reached by this failure) is that `.env`'s `OPEN_AI_API_KEY` does not match the `OPENAI_API_KEY` name the server reads — that would block extraction again even after the service-role key is fixed.
- Duplicates: not tested this run (per plan — rate-limit makes repeated live calls slow, and this run never got a first successful extraction to duplicate)
- Confirm/Correct/Reject/Un-confirm all behave as expected: **not tested — blocked upstream, no extracted facts exist to act on**
- Re-extraction duplicate behavior matches documented limitation: not tested this run

### API-level run 2 — 2026-08-24 (BLOCKED — different, deeper failure; not a pass)

Founder fixed both `.env` gaps from run 1 (`OPEN_AI_API_KEY` → `OPENAI_API_KEY`, added `SUPABASE_SERVICE_ROLE_KEY`) and restarted the server. Re-ran from the extract call with a fresh sign-in.

- [x] Server responds (`/api/health` → 200) on a confirmed-fresh `npm run dev` process (new PIDs, not the leftover pair from run 1)
- [x] Service-role config error from run 1 is gone — progressed further (0.93s vs 0.29s) before failing differently
- [ ] `POST /api/resumes/{id}/extract` → **HTTP 500**, body `{"error":"Could not look up this resume. Please try again."}` — a real Postgres/PostgREST error on the `resume_documents` SELECT, not a "not found" (that path returns a different `kind: "not_found"` result in `extractFacts.ts`)

**Root cause, confirmed by replaying the identical service-role query directly against PostgREST** (`GET /rest/v1/resume_documents?id=eq...` with the service-role key):
```
{"code":"42501","message":"permission denied for table resume_documents","hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.resume_documents TO service_role;"}
```
`supabase/migrations/20260813184932_resume_documents.sql` (predates both MP-F1 and MP-F2, dated 2026-08-13) grants `select, insert, delete` to `authenticated` only — it never grants anything to `service_role`. Compare `extracted_facts` and `fact_confirmations` (MP-F1/MP-F2's own migrations), which both correctly `grant select, insert, update, delete ... to service_role`. This means the extraction endpoint's ownership-check query has never been able to succeed against a database with this migration applied as-is — a pre-existing gap this smoke test surfaced, not something either mini-phase introduced. Unit tests never caught it because they mock the Supabase client entirely (no real grants involved).

Not yet reached/verified: whether `storage.objects` grants are sufficient for the service-role download step once this is fixed (separate schema, not touched by this migration — plausibly fine, not independently confirmed).

Steps 3 (verify extracted_facts/fact_confirmations rows) and 4 (candidate RLS writes) not run — nothing was extracted.

### API-level run 3 — 2026-08-24 (BLOCKED — OpenAI account quota, not a JobBeacon bug; not a pass)

Applied `20260823120000_resume_documents_service_role_grant.sql` (`grant select on public.resume_documents to service_role;`), `supabase db reset` (re-applied cleanly), `supabase test db` re-confirmed **29 files / 451 tests, all pass**. Recreated the test user/candidate_profiles/resume (wiped by the reset) and re-ran from the extract call.

- [x] The run 2 permission error is gone — the extract call now progresses past the `resume_documents` lookup
- Server-process note: the founder's `npm run dev` process had died between runs (unrelated `node --watch` restart-loop issue on spurious `node_modules` file-change events — not a JobBeacon code bug, a dev-tooling/Windows-watcher flake). I started a one-off `node --env-file-if-exists=.env --import=tsx server/index.ts` (no `--watch`) to get a stable process for this run; did not modify any script.
- [ ] `POST /api/resumes/{id}/extract` → **HTTP 500** in 5.59s, body `{"error":"Could not extract facts from this resume right now. Please try again."}` — this is `extractFacts.ts`'s catch-all around `runResumeFactExtraction()`, reached only after resume lookup, storage download, and PDF text extraction all succeeded (confirms `storage.objects` grants for `service_role` are fine — the run 2 "not yet verified" item above is now resolved)

**Root cause, confirmed by directly replaying the server's exact OpenAI calls with the real `.env` key** (never printed; used only in an Authorization header, matched to the server's exact model — `gpt-4o-mini`):
- `GET /v1/models` → 200 (the key itself is valid and correctly read — including a genuine space character inside the key value, which is unusual but not itself the problem)
- `POST /v1/chat/completions` (same model as the server) → **429**, `{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details..."}}`

This is an OpenAI account billing/quota exhaustion, not a code or database bug — nothing in this repository can fix it. Per the run instructions, stopped here rather than retrying (extraction is rate-limited). Steps verifying `extracted_facts`/`fact_confirmations` rows and candidate RLS writes were not run — no facts were ever extracted.

**Net result of this session's 3 runs:** the entire extraction pipeline is now verified working end-to-end up to and including the OpenAI API call itself (auth, resume ownership check, storage download, PDF text extraction) — the two real bugs found (`SUPABASE_SERVICE_ROLE_KEY`/`OPENAI_API_KEY` misconfigured in `.env`, and the missing `resume_documents` service-role grant) are both fixed. The only remaining blocker to a full pass is OpenAI account credits, which is an external, non-code dependency.

---

## MP-R1 Target Roles Manual Verification (DEFERRED — no live environment in this session)

Status: not yet run against a live environment — same blocker as the MP-F1/MP-F2 smoke test above (no local Supabase/browser access in this session). 25 new unit tests (`roleTaxonomy.test.ts`, `roleSuggestions.test.ts`, `candidateSelectedRoles.test.ts`) and a full-workspace `npm run typecheck && npm test` (543 tests, all passing) are the only verification performed so far.

### Pre-checks

- [ ] Candidate has at least one resume with confirmed `current_title` and/or `skill` facts (MP-F2 confirmation flow — suggestions require confirmed facts, per-fact `pending`/`rejected` rows are ignored)

### Test steps

1. Navigate to Target Roles (`/#/target-roles`)
2. Confirm the page loads with "Selected roles", "Search roles", and suggestion sections (only tiers — Primary/Strong/Related — with matches render; empty tiers are omitted, not shown empty)
3. Search for a role (e.g. "engineer") — confirm matching taxonomy entries appear with an Add button
4. Click Add on a search result — confirm it moves to "Selected roles" and drops out of the search results and suggestion lists
5. Click Add on a suggested role — confirm the same move-on-select behavior
6. Click Remove on a selected role — confirm it disappears from "Selected roles" and reappears in search/suggestions if still eligible
7. Reload the page — confirm selected roles persist (`candidate_selected_roles` is the source of truth, not local component state)
8. Re-add a role already selected (e.g. two quick clicks) — confirm no duplicate row and no error surfaces (23505 idempotency, same pattern as exclusions)

### Known-expected behavior (NOT bugs)

- No suggestions render until the candidate has at least one confirmed `current_title` or `skill` fact
- A candidate with confirmed skills but no confirmed title can still get Related-tier suggestions (skill-only matching — see `roleSuggestions.ts` comment)

---

## Regression Tests (after every mini-phase)

### Auth

- [ ] Login / logout / session persist / wrong password error

### Navigation (UI phases)

- [ ] 10 sidebar sections navigate
- [ ] Mobile 375px drawer, no horizontal scroll
- [ ] No console errors

### Panels (data phases)

- [ ] Resumes upload/view/delete
- [ ] Target roles search/select/remove persists (MP-R1)
- [ ] Automation authorize/pause/resume/stop
- [ ] Exclusions persist
- [ ] MFA section renders

### Worker (server-side, no UI)

- [ ] `npm run worker:applications` completes and exits 0 (MP-W1)

### Known-expected console errors (NOT bugs)

- POST candidate_profiles 409 after login = idempotent design
- 42501 anon permission = old signup log (report only if reproduces on refresh)
- load_embeds.js = browser extension noise

---

## MP-W1 Application Worker Manual Verification (DEFERRED — no live environment in this session)

Status: not yet run against a live environment — same blocker as MP-F1/MP-F2/MP-R1 above (no local Supabase/dev-server access in this session). 9 new unit tests (`server/applications/runner.test.ts`, all mocked) and a full-workspace `npm run typecheck && npm test` (552 tests, all passing) are the only verification performed so far.

**Scope note**: this phase ships single-pass batch mode only (`npm run worker:applications`), meant to be invoked by an external scheduler (cron). Continuous daemon/polling mode and `SIGINT`/`SIGTERM` graceful shutdown were explicitly deferred to a later scheduling/deployment phase — no such pattern exists anywhere in this repo yet (confirmed by inspection: `server/ingestion/worker.ts` only exports a single claim-and-process function, not a daemon loop, and there is no `SIGINT`/`SIGTERM` handling anywhere in `server/`).

### Pre-checks

- [ ] At least one candidate has `automation_authorizations.status = 'authorized'` and at least one `candidate_selected_roles` row
- [ ] At least one `vacancies` row has `trust_status` of `VERIFIED` or `VERIFIED_INCOMPLETE`
- [ ] `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are set (the CLI uses the service-role client, same as every other server-side worker)

### Test steps

1. Run `npm run worker:applications`
2. Confirm it prints a `[applications:cli] batch complete` summary (`candidateIds`, `vacancyIds`, `plansEvaluated`, `plansEligible`, `planningFailures`, `attemptsProcessed`) and exits with code 0
3. Query `application_plans` — confirm one row per (authorized candidate, verified vacancy) pair that didn't already have one
4. Re-run the same command — confirm no duplicate `application_plans` rows are created (idempotent `getOrCreatePlan`, unchanged from R4.3) and `plansEvaluated` still reflects every pair (re-evaluated, not re-inserted)
5. If any plan came out eligible, confirm exactly one `application_attempts` row exists for it and `attemptsProcessed` in the printed summary reflects the drain

### Known-expected behavior (NOT bugs)

- `plansEligible` will be 0 in this environment today — `rate_and_abuse_controls` is a documented permanent placeholder, and `application_support` (MP-A1, see below) is a real capability check that simply has no adapter registered as supported yet — either way, no real candidate can be eligible yet regardless of this phase
- The batch plans every active-candidate x verified-vacancy pair (no pre-filter) — `role_match` and the other gates decide eligibility inside `planApplication`, not a separate query filter in the runner
- A single candidate/vacancy pair failing to plan (e.g. a bad row) is logged to console and recorded in `planningFailures`, not a batch-ending crash

## MP-A1 Application Adapter Capability Model — Verification

Status: no live environment needed to verify the gate-logic change itself — the `application_support` gate is a pure function of `vacancies`/adapter state with no external dependency, and its behavior is unchanged for every real source today (still fails with `NO_ADAPTER_REGISTERED_FOR_SOURCE`). 8 new unit tests (2 in `unsupportedAdapter.test.ts`, 1 in `registry.test.ts`, 3 in `eligibilityGate.test.ts` covering the pass/custom-reason-code/context-forwarding paths via a mocked adapter double, plus the existing MP-W1/prior suites re-verified unchanged) and a full-workspace `npm run typecheck && npm test` (558 tests, all passing) are the verification performed.

**Scope note**: this phase extends the existing `ApplicationAdapter` interface (from R7-M2) with `sourceCode`/`displayName`/`isAutomatedSubmissionSupported`/`validateSupport()` — it does **not** register any source as actually supported. `resolveApplicationAdapter` still resolves every real `source_code` (`greenhouse`, `lever`, `adzuna`, `usajobs`, anything else) to `unsupportedAdapter`, matching `source_policies.automated_application_allowed = false` for every row. The `application_support` gate's reason code (`NO_ADAPTER_REGISTERED_FOR_SOURCE`) is unchanged from R7-M2 — confirmed byte-identical behavior for every existing test.

### Regression check (no live environment needed)

- [ ] `npm test -- server/applications` — confirm all adapter/gate/worker/runner suites still pass
- [ ] Confirm `result.gates.application_support` for a real vacancy (any `source_code`) still returns `{ status: "fail", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE", detail: { sourceCode } }` — no observable behavior change for any real candidate

### When a real adapter is registered (future phase)

1. Add a `case "<source_code>":` to `server/applications/adapters/registry.ts` returning an object satisfying `ApplicationAdapter` with `isAutomatedSubmissionSupported: true`
2. Confirm `application_support` now passes for that source with `detail: { adapter: "<source_code>" }`
3. Confirm `source_policies.automated_application_allowed` is also flipped to `true` for that source — `source_policy` and `application_support` are two independent gates and both must pass

## Future phases (placeholders)

- MP-W2 (or similar): continuous daemon/polling mode + `SIGINT`/`SIGTERM` graceful shutdown, deferred out of MP-W1's scope
- First real per-source submission adapter (e.g. Greenhouse), once an authorized employer relationship and credentials exist — MP-A1 built the capability model this depends on, but registers none
