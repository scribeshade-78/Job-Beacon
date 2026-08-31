# Phase 2.1 — JD Extraction & Fit Analysis: Design

Status: approved 2026-08-31. Supersedes nothing; additive to the current `main`.

Source spec: "JobBeacon Response Intelligence" PRD §11 (Opportunity Intelligence)
and §12.1 (Opportunity Priority Scoring), as supplied by the founder on
2026-08-31. That PRD revision is not committed to `docs/`; the relevant clauses
are quoted inline below.

## Scope

**In scope for 2.1:**

- Clean JD text extraction from the verbatim provider payload already stored in
  `vacancy_versions.raw_payload`, per-adapter, deterministic, pure TypeScript.
- `vacancy_jd_snapshots` table (§11.1 JD Preservation).
- `fit_analyses` table storing Technical Fit (AI), Missing Evidence (AI),
  Practical Eligibility (pure-TS rules engine), Hard Blockers, soft penalties.
- `fit_analysis_jobs` Postgres lease queue + `claim_fit_analysis_job()` RPC,
  mirroring `ingestion_jobs` / `claim_ingestion_job()`.
- Two enqueue triggers: (a) a vacancy transitioning **into** `VERIFIED` in
  `scoreVacancy`, (b) a `fact_confirmations` row moving to `confirmed` via a DB
  `AFTER UPDATE` trigger.
- `runOneFitAnalysisJob` worker, `runFitAnalysisBatch` drain loop, `worker:fit`
  CLI, `POST /api/worker/run-fit` route (`requireWorkerSecret`).
- Full unit (vitest) + pgTAP coverage.

**Deferred to Phase 2.2** (schema leaves room; no code now):

- The §12.1 weighted 8-factor Opportunity Priority Score and its column. Five of
  its eight inputs (response stage, employment arrangement, compensation
  quality, urgency, user preferences) have no data source in the repo yet.
- The Opportunities UI surface (Technical Fit / Practical Eligibility / reasons /
  risks displayed separately, §12.1).
- §11.4 compensation model (stated vs estimated, source + confidence display).
- Deterministic evaluation of work authorisation, payroll country, security
  clearance (hard blockers) and night-shift schedule / experience-certification
  (soft penalties). These need an extended `extracted_facts` vocabulary and/or
  JD-clause detection. Their reason codes are **defined and reserved** in 2.1 so
  the taxonomy is stable, but never emitted.
- Screenshot capture for JD snapshots (§11.1 "permitted screenshot"). Only
  `html_snapshot` is captured in v1.
- Re-analysis when a posting is edited (a new `vacancy_versions` row).
  `fit_analyses.jd_snapshot_id` makes that staleness detectable later.

## Approach

The one design fork is **lease queue vs. scan-for-unprocessed-rows**. Phase 1 and
3 mailbox workers scan; ingestion uses a lease queue. A fit computation is a
fan-out unit of work (one per candidate x vacancy) with its own retry/backoff
needs, not a "sweep rows lacking a column" pass, so it takes a lease queue:
`fit_analysis_jobs` mirroring `ingestion_jobs` (`status` / `attempts` /
`leased_until` / dead-letter, plus a `claim_fit_analysis_job()` RPC using
`FOR UPDATE SKIP LOCKED`).

New code lives in a new `server/opportunities/` domain directory, parallel to
`server/trust/`, `server/mailbox/`, `server/applications/`. Each unit is a pure,
independently testable function; I/O is isolated to `analyzeFit.ts` (data
loading) and `fitWorker.ts` (queue + persistence).

## Data flow

```
INGESTION (existing)
  server/ingestion/worker.ts -> scoreVacancy() sets vacancies.trust_status
      NEW: if prior status != 'VERIFIED' and new bucket == 'VERIFIED'
           -> enqueueFitJobsForVacancy(client, vacancyId)
              upsert one fit_analysis_jobs row per active candidate
              (automation_authorizations.status = 'authorized'
               INTERSECT has >= 1 candidate_selected_roles row)
              -- active-candidate query reused from server/applications/runner.ts

FACT CONFIRMATION (existing, browser-side RLS UPDATE - no server code runs)
  NEW: trigger fit_enqueue_on_fact_confirmed
       AFTER UPDATE ON public.fact_confirmations
       WHEN (new.status = 'confirmed' AND old.status IS DISTINCT FROM 'confirmed')
       -> plpgsql: resolve candidate_id via
          fact_confirmations.extracted_fact_id -> extracted_facts.candidate_id
          INSERT fit_analysis_jobs (candidate_id, vacancy_id)
          SELECT :candidate_id, v.id FROM public.vacancies v
          WHERE v.trust_status IN ('VERIFIED','VERIFIED_INCOMPLETE')
          ON CONFLICT (candidate_id, vacancy_id)
          DO UPDATE SET status='pending', attempts=0, updated_at=now()

FIT WORKER (new)   npm run worker:fit   /   POST /api/worker/run-fit
  runOneFitAnalysisJob(client, deps):
    claim_fit_analysis_job() RPC   (5-min lease, attempts++)
    load candidate confirmed facts
       (extracted_facts + fact_confirmations two-step, as resumeGenerator.ts /
        eligibilityGate.ts already do; effective value = corrected_value ?? fact_value)
    get-or-create vacancy_jd_snapshots row for the vacancy's latest vacancy_versions:
       jdExtraction.extractJd(source_code, raw_payload)
         -> { cleanText, sections[], htmlSnapshot, canonicalUrl }
    practicalEligibility.evaluate({ candidateLocation, vacancy })
       -> { score, hardBlockers[], softPenalties[] }
    if JD cleanText is non-empty:
       analyzeTechnicalFit(openai, { jdText, sections, factsSummary })
          -> { overall, components{6}, missingEvidence[], topReasons[], risks[] }
       jd_text_available = true
    else (provider payload carried no usable JD text):
       skip the AI call; technical_fit_score / technical_fit_components = null;
       missing_evidence / top_reasons / risks = []; jd_text_available = false
       -- NOT an error, NOT retried: there is structurally nothing to analyse
    assemble fit_analyses row:
       hardBlockers non-empty -> practical_eligibility_score = 0,
                                 eligibility_capped = true
                                 (technical_fit_* still stored when available)
    upsert fit_analyses ON CONFLICT (candidate_id, vacancy_id)
    mark job done / retry-with-backoff (2**attempts min, cap 60) / dead-letter
       -- retry + dead-letter logic copied from server/ingestion/worker.ts;
       -- only genuine failures (AI malformed output, DB error, network) retry
    never throws per job
```

**Redundant-spend guard.** `scoreVacancy` runs on every ingestion pass, so the
vacancy enqueue fires only on a status **transition into** `VERIFIED` — compare
the row's prior `trust_status` (which `scoreVacancy` already loads) against the
new bucket. Re-analysis on a JD edit is out of 2.1 scope.

## Schema

### `vacancy_jd_snapshots` (§11.1)

> §11.1 JD Preservation: Store canonical URL and capture date. Store cleaned JD
> text with section boundaries. Store permitted screenshot or HTML snapshot when
> available. Retain new versions when a posting is edited.

| column | type | notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | |
| `vacancy_id` | `uuid not null` -> `vacancies(id) on delete cascade` | |
| `vacancy_version_id` | `uuid not null` -> `vacancy_versions(id) on delete cascade` | ties the snapshot to the immutable raw version; a new posting version yields a new snapshot |
| `canonical_url` | `text not null` | §11.1 "canonical URL" |
| `captured_at` | `timestamptz not null default now()` | §11.1 "capture date" |
| `clean_text` | `text not null` | §11.1 "cleaned JD text" |
| `sections` | `jsonb not null` | §11.1 "with section boundaries": `[{ heading: string \| null, body: string }]` |
| `html_snapshot` | `text` | §11.1 "HTML snapshot when available": Greenhouse/Lever raw HTML; null for Adzuna/USAJOBS |
| `source_code` | `text not null` | adapter mapping that produced this |
| `extractor_version` | `text not null` | `"jd-extract-v1"`; bump when mapping logic changes |
| `created_at` | `timestamptz not null default now()` | |

- `unique (vacancy_version_id)` — one snapshot per raw version; re-run upserts.
- Index on `vacancy_id`.
- RLS: `authenticated` SELECT (public employer-posting content, no candidate
  scoping); `service_role` full DML. Revoke-all-then-grant-back, as every prior
  migration.

### `fit_analyses`

§11.2 Resume Match Breakdown (Technical Fit) — match against: core technical
skills, cloud alignment, engineering responsibilities, scale/performance
evidence, seniority, domain; must identify "Missing evidence".
§11.3 Eligibility Rules — hard blockers cap score to 0; soft penalties.

| column | type | notes |
|---|---|---|
| `id` | `uuid pk` | |
| `candidate_id` | `uuid not null` -> `candidate_profiles(id) on delete cascade` | |
| `vacancy_id` | `uuid not null` -> `vacancies(id) on delete cascade` | |
| `jd_snapshot_id` | `uuid` -> `vacancy_jd_snapshots(id)` | which JD version this was computed against; NULL when no JD text was available |
| `jd_text_available` | `boolean not null default false` | false ⇒ the provider payload carried no usable JD text; Technical Fit was skipped, Practical Eligibility still computed |
| `technical_fit_score` | `int check (>= 0 and <= 100)` | AI overall; **NULL when `jd_text_available = false`** |
| `technical_fit_components` | `jsonb` | six §11.2 dims, each `{ score int, rationale text }`; **NULL when `jd_text_available = false`** |
| `missing_evidence` | `jsonb not null default '[]'::jsonb` | `string[]` — JD-required, absent from facts; `[]` when no JD text |
| `practical_eligibility_score` | `int check (>= 0 and <= 100)` | NULL when `INSUFFICIENT_DATA` |
| `hard_blockers` | `jsonb not null default '[]'::jsonb` | `[{ code, detail }]` |
| `soft_penalties` | `jsonb not null default '[]'::jsonb` | `[{ code, detail }]` — empty in v1 |
| `eligibility_capped` | `boolean not null default false` | true => 2.2 forces priority score to 0 |
| `top_reasons` | `jsonb not null default '[]'::jsonb` | `string[]` (§12.1 "top reasons") |
| `risks` | `jsonb not null default '[]'::jsonb` | `string[]` (§12.1 "risks") |
| `model_version` | `text not null` | |
| `prompt_version` | `text not null` | |
| `analyzed_at` | `timestamptz not null default now()` | |
| `created_at` | `timestamptz not null default now()` | |

- `unique (candidate_id, vacancy_id)` — one current analysis per pair; worker
  upserts (same precedent as `response_classifications` unique `message_id`).
- Indexes on `candidate_id`, `vacancy_id`.
- RLS: `authenticated` SELECT where `candidate_id = (select auth.uid())`; no
  `authenticated` INSERT/UPDATE/DELETE (system-generated output, like
  `application_plans`); `service_role` full DML.

### `fit_analysis_jobs` (lease queue)

| column | type | notes |
|---|---|---|
| `id` | `uuid pk` | |
| `candidate_id` | `uuid not null` -> `candidate_profiles(id) on delete cascade` | |
| `vacancy_id` | `uuid not null` -> `vacancies(id) on delete cascade` | |
| `status` | `text not null default 'pending' check (status in ('pending','leased','done','failed'))` | |
| `attempts` | `integer not null default 0` | |
| `max_attempts` | `integer not null default 5` | |
| `leased_until` | `timestamptz` | |
| `last_error` | `text` | |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

- `unique (candidate_id, vacancy_id)` — enqueue does
  `ON CONFLICT (candidate_id, vacancy_id) DO UPDATE SET status='pending',
  attempts=0, last_error=null, updated_at=now()`. One row per pair ever;
  re-arming an existing `done`/`failed` row is how a re-analysis is requested.
- Index on `(status, leased_until)`.
- RLS: `service_role` only (internal worker state, exactly like
  `ingestion_jobs`).

### `claim_fit_analysis_job()`

Byte-for-byte the `claim_ingestion_job()` shape: `language plpgsql`,
`SECURITY INVOKER`, `SELECT ... WHERE (status = 'pending' OR (status = 'leased'
AND leased_until < now())) AND attempts < max_attempts ORDER BY created_at
FOR UPDATE SKIP LOCKED LIMIT 1`, then `UPDATE ... SET status='leased',
leased_until = now() + interval '5 minutes', attempts = attempts + 1`. `EXECUTE`
granted to `service_role` only; revoked from `public`/`anon`/`authenticated`.

### `fit_enqueue_on_fact_confirmed` trigger

`AFTER UPDATE ON public.fact_confirmations FOR EACH ROW WHEN (new.status =
'confirmed' AND old.status IS DISTINCT FROM 'confirmed')` calling a
`SECURITY DEFINER` plpgsql function (it INSERTs into `fit_analysis_jobs`, which
`authenticated` — the role performing the fact confirmation — has no grant on).
The function:

1. Resolves `candidate_id` via `fact_confirmations.extracted_fact_id ->
   extracted_facts.candidate_id` (one hop — `extracted_facts` carries its own
   `candidate_id` column).
2. `INSERT INTO public.fit_analysis_jobs (candidate_id, vacancy_id)
   SELECT <candidate_id>, v.id FROM public.vacancies v
   WHERE v.trust_status IN ('VERIFIED','VERIFIED_INCOMPLETE')
   ON CONFLICT (candidate_id, vacancy_id)
   DO UPDATE SET status='pending', attempts=0, last_error=null, updated_at=now();`

`-- ponytail: fan-out inside a trigger, bounded by the verified-vacancy count;
acceptable at pre-launch volume, revisit if that count grows large.`

Precedent for triggers in this repo: `20260816231318_moderation_decisions_appeal_separation.sql`,
`20260826030000_company_fact_corrections.sql`.

## JD extraction (`server/opportunities/jdExtraction.ts`, pure)

`extractJd(sourceCode: string, rawPayload: unknown): JdExtraction`
where `JdExtraction = { cleanText: string; sections: JdSection[]; htmlSnapshot:
string | null; canonicalUrl: string | null }` and `JdSection = { heading: string
| null; body: string }`.

| adapter | field(s) in `raw_payload` | handling |
|---|---|---|
| `greenhouse` | `content` (HTML-entity-escaped string), `absolute_url` | decode entities, detect sections from `<h1>`..`<h4>` / `<b>` / `<strong>` headings, strip tags to text. `htmlSnapshot` = decoded `content`. `canonicalUrl` = `absolute_url`. |
| `lever` | `description` / `descriptionPlain` (HTML/plain), `lists[]` (`{ text, content }`), `hostedUrl` | intro section from `descriptionPlain` (fall back to stripped `description`); one section per `lists[]` entry (`heading = text`, `body` = stripped `content`). `htmlSnapshot` = `description` + serialised lists. `canonicalUrl` = `hostedUrl`. |
| `adzuna` | `description` (short plain text, often truncated), `redirect_url` | `cleanText` = `description`; `sections` = `[{ heading: null, body: description }]`; `htmlSnapshot` = null. `canonicalUrl` = `redirect_url`. |
| `usajobs` | `MatchedObjectDescriptor.UserArea.Details` (`MajorDutiesList[]`, `JobSummary`, `QualificationSummary`, `Requirements`, `Evaluations`, ...), `PositionURI` | one labelled section per present field; `MajorDutiesList` joined to a bulleted body. `htmlSnapshot` = null. `canonicalUrl` = `PositionURI`. |
| unknown | — | throws `Error("No JD extractor registered for source_code \"...\"")`, same discipline as the discovery adapter registry. |

An empty/whitespace `cleanText` after extraction is **not** an error — several
providers (Adzuna truncation, USAJOBS summary-only search results) can legitimately
yield no usable JD text. `extractJd` returns `cleanText: ""` in that case; the
worker persists a `vacancy_jd_snapshots` row only when `cleanText` is non-empty,
sets `fit_analyses.jd_text_available = false`, and marks the job `done` (no
retry). Fixtures for tests are built from the sample payloads already present in
each adapter's `*.test.ts`, extended with the description/content fields the
provider objects actually carry.

Adapter payload reality (verified 2026-08-31): Greenhouse `content` (HTML) and
Lever `description` / `descriptionPlain` / `lists[]` are present in `raw_payload`
today; Adzuna `description` is present but provider-truncated; USAJOBS search
results do not carry `UserArea.Details` without a `Fields=Full` request (an
out-of-scope follow-up). `extractJd` reads `raw_payload` as `unknown` and
narrows defensively — a missing field yields no section, not a throw.

## AI prompt (`server/opportunities/fitPrompt.ts`)

Mirrors `server/mailbox/classifyMessage.ts`:

- `export const FIT_ANALYSIS_PROMPT_VERSION = "fit-analysis-v1";`
- `export const DEFAULT_FIT_MODEL = "openai/gpt-4o-mini";`
- Strict `response_format: { type: "json_schema", json_schema: { name, strict:
  true, schema } }`.
- An independent hand-written validator `isValidRawFitAnalysis(value): value is
  RawFitAnalysis` — not a re-statement of the schema; range-checks every score
  in `[0,100]`, checks every component key present, checks `missing_evidence` /
  `top_reasons` / `risks` are `string[]`. Malformed output is rejected outright,
  never partially stored.
- `analyzeTechnicalFit(openaiClient: Pick<OpenAI, "chat">, input, model?)` —
  same injection shape as `classifyMessageContent`.

`RawFitAnalysis`:

```
{
  overall: number,                       // 0-100
  components: {
    core_technical_skills:        { score: number, rationale: string },
    cloud_alignment:              { score: number, rationale: string },
    engineering_responsibilities: { score: number, rationale: string },
    scale_performance_evidence:   { score: number, rationale: string },
    seniority:                    { score: number, rationale: string },
    domain:                       { score: number, rationale: string }
  },
  missing_evidence: string[],
  top_reasons: string[],                  // <= 3
  risks: string[]                         // <= 3
}
```

System prompt (essence): compare one JD against the candidate's **confirmed**
resume facts; score only on evidence present in the inputs; never invent a
qualification; `missing_evidence` uses exact JD phrases; `risks` may mention
work-authorisation / clearance / payroll-country language seen in the JD, but
that is advisory only. User message: rendered `clean_text` + section headings,
then a compact bullet list of the candidate's confirmed facts.

The AI never emits reason codes. Only the rules engine does.

## Practical Eligibility rules engine (`server/opportunities/practicalEligibility.ts`, pure)

§11.3 hard blockers: work authorisation (unless India contractor/EOR),
location/presence, payroll country (US employee only), security clearance —
"Cap score to 0". Soft penalties: schedule (night shift), experience/
certification.

`evaluate(input): PracticalEligibility` where `input = { candidateLocation:
string | null; vacancy: { country: string | null; region: string | null; city:
string | null; remoteType: 'remote' | 'hybrid' | 'on_site' | null } }` and
`PracticalEligibility = { score: number | null; hardBlockers: ReasonEntry[];
softPenalties: ReasonEntry[] }`.

v1 is location-only and fully deterministic:

| case | result |
|---|---|
| `remoteType = 'remote'` | `score 100`, no blockers |
| `hybrid` / `on_site`, candidate location resolves to the vacancy's country | `score 100` |
| `hybrid` / `on_site`, candidate country != vacancy country | hard blocker `LOCATION_PRESENCE`, `score 0` |
| vacancy `country` is null | `score 100`, informational `LOCATION_UNKNOWN` (do not penalise missing source data) |
| `candidateLocation` is null | `score null`, informational `INSUFFICIENT_DATA` (not a blocker) |

Country resolution: lowercase substring match of the free-text candidate
location against the vacancy `country` plus a small alias map (`us` / `usa` /
`united states` / `u.s.`; `uk` / `united kingdom` / `u.k.`; `india` / `in`;
`uae` / `united arab emirates`; ...). `// ponytail: naive country substring
match; add geocoding only if false-positives show up.`

`softPenalties` is always `[]` in v1 (`SCHEDULE_NIGHT_SHIFT`,
`EXPERIENCE_CERTIFICATION` reserved, no deterministic source yet). A small
`eligibilityInfoCode(input, result)` helper returns the `INSUFFICIENT_DATA` /
`LOCATION_UNKNOWN` `ReasonEntry` a consumer should show, so the "why is the
score null" mapping lives next to the rules. Informational codes are **not
persisted** on `fit_analyses` in v1 — they are derivable (null score ⇒
`INSUFFICIENT_DATA`; non-remote + null vacancy country ⇒ `LOCATION_UNKNOWN`) and
`soft_penalties` stays genuinely empty as the migration comment states.

## Reason codes (`server/opportunities/reasonCodes.ts`)

A frozen const map, `SCREAMING_SNAKE` keys with human descriptions — same style
as `server/trust/hardBlocks.ts` / `positiveReasonCodes.ts`.

Hard blockers (cap Practical Eligibility to 0):

| code | v1 | meaning |
|---|---|---|
| `LOCATION_PRESENCE` | emitted | non-remote role, candidate not in the required country |
| `WORK_AUTHORISATION` | reserved | JD requires work auth the candidate cannot satisfy (unless India contractor/EOR) — needs a work-auth fact |
| `PAYROLL_COUNTRY_US_ONLY` | reserved | JD states US-employee / US-payroll only — needs JD-clause detection |
| `SECURITY_CLEARANCE` | reserved | JD requires an active security clearance — needs JD-clause detection |

Soft penalties (reduce score, no cap):

| code | v1 | meaning |
|---|---|---|
| `SCHEDULE_NIGHT_SHIFT` | reserved | JD indicates a night-shift schedule |
| `EXPERIENCE_CERTIFICATION` | reserved | candidate below a stated experience / certification bar |

Informational (not a blocker): `LOCATION_UNKNOWN`, `INSUFFICIENT_DATA`.

Reserved codes are defined now so the enum is stable and consumers/pgTAP can
rely on it, each documented "not emitted until <precondition>".

## Worker, CLI, route

- `server/opportunities/analyzeFit.ts` — `analyzeFit(deps, { candidateId,
  vacancyId })`: loads confirmed facts + the JD snapshot (creating it from the
  latest `vacancy_versions` row if absent), runs `practicalEligibility.evaluate`
  and `analyzeTechnicalFit`, assembles and returns the `fit_analyses` row shape.
  Applies the hard-blocker cap. `deps` injects the Supabase client and the
  `Pick<OpenAI, "chat">` client.
- `server/opportunities/fitWorker.ts` — `runOneFitAnalysisJob(client, deps)`:
  claim -> `analyzeFit` -> upsert `fit_analyses` -> mark `done` /
  retry-with-backoff / dead-letter at `max_attempts`. Never throws per job.
  Retry + dead-letter code copied from `server/ingestion/worker.ts`.
- `server/opportunities/runner.ts` — `runFitAnalysisBatch(client, deps, {
  maxPerBatch = 50 })`: drain loop, returns `{ claimed, analyzed, capped,
  noJdText, failed, claimError? }` (`claimError` set only if the claim RPC
  itself threw). Mirrors `server/applications/runner.ts`.
- `server/opportunities/enqueue.ts` — `enqueueFitJobsForVacancy(client,
  vacancyId)` only. The candidate-side path (facts confirmed) is the DB trigger,
  so no TS `enqueueFitJobsForCandidate` is built in 2.1 (YAGNI). The
  active-candidate query is factored out of `server/applications/runner.ts` into
  a shared helper (`server/applications/activeCandidates.ts` or similar) and
  imported by both `runner.ts` and `enqueue.ts` — no second copy of the rule.
- `server/opportunities/cli.ts` — `npm run worker:fit`; service-role client; one
  batch; structured summary; exit. Mirrors `server/applications/cli.ts` /
  `server/mailbox/matchCli.ts`.
- `POST /api/worker/run-fit` in `server/index.ts` — `requireWorkerSecret`, calls
  `runFitAnalysisBatch`, returns counts. Mirrors `POST
  /api/worker/match-messages`, including the error-message-disclosure guard from
  commit `f97ab40`.
- Env: reuses `OPENROUTER_API_KEY` and the `OPENAI_MODEL` / `OPENROUTER_MODEL`
  fallback chain. No new required env. Optional `FIT_ANALYSIS_MODEL` override via
  the same `process.env` chain `classifyMessage.ts` uses.

## Testing

Unit (vitest):

- `jdExtraction.test.ts` — one fixture per adapter (greenhouse HTML, lever
  lists, adzuna plain, usajobs structured): `clean_text` non-empty, sections
  parsed, `html_snapshot` presence correct; unknown source throws; a payload
  with no description field yields `cleanText: ""` (no throw).
- `practicalEligibility.test.ts` — all five rows of the rules table.
- `fitPrompt.test.ts` — validator accepts a well-formed object; rejects wrong
  keys, a score > 100, a non-array `missing_evidence`, a missing component.
- `analyzeFit.test.ts` — mocked `openai` + in-memory data: happy path assembles
  the row (`jd_text_available = true`); `LOCATION_PRESENCE` sets
  `eligibility_capped` and `practical_eligibility_score = 0` while
  `technical_fit_*` stays populated; empty JD text -> `jd_text_available = false`,
  `technical_fit_* = null`, no AI call, no throw; malformed AI output throws (job
  will retry).
- `fitWorker.test.ts` — mocked claim RPC: success upserts + marks `done`;
  `analyzeFit` throws -> retry with backoff; attempts exhausted -> `failed`.
- `enqueue.test.ts` — active-candidate filter (authorized INTERSECT >= 1 role);
  `ON CONFLICT` re-arms a `done` row to `pending`; no active candidates -> no
  rows written.
- `server/index.test.ts` — `/api/worker/run-fit` rejects without the secret;
  calls the batch; returns counts (batch fn mocked, mirrors the match-messages
  route test).

pgTAP (`supabase/tests/database/`):

- `vacancy_jd_snapshots_rls.test.sql` — `authenticated` SELECT ok; `anon`
  denied; `authenticated` INSERT/UPDATE/DELETE denied; `service_role` ok.
- `fit_analyses_rls.test.sql` — candidate A sees only their own rows; B's rows
  invisible to A; `authenticated` writes denied; `unique (candidate_id,
  vacancy_id)` enforced.
- `fit_analysis_jobs_rls.test.sql` — `authenticated` and `anon` fully denied;
  `service_role` full; `claim_fit_analysis_job()` leases one pending row (sets
  `leased_until`, increments `attempts`), skips an already-leased row, respects
  `max_attempts`.
- `fact_confirmations_fit_trigger.test.sql` — updating a `fact_confirmations`
  row to `confirmed` inserts `fit_analysis_jobs` rows for that candidate x each
  verified vacancy; a re-confirm (already `confirmed`) inserts nothing new.

Verification run: `npm run typecheck`, `npm test` (full workspace), `supabase
test db` (full pgTAP) against a fresh `supabase db reset`. No live OpenRouter
call in automated tests (mocked). A manual smoke-test section is added to
`docs/MANUAL_TESTS.md`.

## Files (all additive unless noted)

```
docs/superpowers/specs/2026-08-31-opportunity-intelligence-phase-2.1-design.md   (this file)
supabase/migrations/
  <ts>_vacancy_jd_snapshots.sql
  <ts>_fit_analyses.sql
  <ts>_fit_analysis_jobs.sql            (table + claim_fit_analysis_job() + fact_confirmations trigger)
supabase/tests/database/
  vacancy_jd_snapshots_rls.test.sql
  fit_analyses_rls.test.sql
  fit_analysis_jobs_rls.test.sql
  fact_confirmations_fit_trigger.test.sql
server/opportunities/
  jdExtraction.ts        + jdExtraction.test.ts
  practicalEligibility.ts + practicalEligibility.test.ts
  reasonCodes.ts
  fitPrompt.ts           + fitPrompt.test.ts
  analyzeFit.ts          + analyzeFit.test.ts
  fitWorker.ts           + fitWorker.test.ts
  runner.ts              + runner.test.ts
  enqueue.ts             + enqueue.test.ts
  cli.ts
server/applications/activeCandidates.ts   (NEW: findActiveCandidateIds, extracted from runner.ts)
server/index.ts                  (MODIFIED: + POST /api/worker/run-fit)
server/index.test.ts             (MODIFIED: + route test + runner mock)
server/applications/runner.ts    (MODIFIED: import findActiveCandidateIds from activeCandidates.ts)
server/trust/scoreVacancy.ts     (MODIFIED: select trust_status; + ScoreVacancyDeps; enqueue on transition into VERIFIED)
server/trust/scoreVacancy.test.ts (MODIFIED: inject no-op enqueue; + 3 transition cases)
package.json                     (MODIFIED: + "worker:fit" script)
docs/MANUAL_TESTS.md             (MODIFIED: + smoke-test section)
```

## Product-invariant check

- Salary labels: `fit_analyses` stores no salary figure; `risks` / `top_reasons`
  are free text. No blending of source classes. §11.4 compensation display is
  2.2.
- Explainability: every hard blocker and soft penalty carries a stable reason
  code + `detail`. Technical Fit carries a per-dimension `rationale`. `risks`
  and `top_reasons` are the §12.1 "reasons and risks" surface.
- Candidate isolation: `fit_analyses` RLS is `candidate_id = auth.uid()`;
  `fit_analysis_jobs` is `service_role` only. pgTAP covers cross-user reads.
- Ingestion resilience: the vacancy enqueue is wrapped so a failure never blocks
  `scoreVacancy` / ingestion (same ethos as the existing non-blocking
  `scoreVacancy` call in the ingestion worker).
- Additive migrations only; no edit to an applied migration.
```
