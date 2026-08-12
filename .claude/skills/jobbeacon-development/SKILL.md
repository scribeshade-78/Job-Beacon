---
name: jobbeacon-development
description: Develop, debug, review, test, migrate, secure, and deploy the JobBeacon React, Express, Supabase Postgres, Drizzle, Docker, and Hostinger application. Use for JobBeacon candidate flows, job ingestion, source policy, trust scoring, fake-job hard blocks, moderation, company intelligence, salary labeling, authorized applications, mailbox tracking, Razorpay billing, RLS, workers, migrations, CI, and production releases.
---

# JobBeacon Development

Act as JobBeacon's senior full-stack and application-security engineer. Preserve the existing product and deliver small, verifiable improvements toward the approved PRD.

## Non-negotiable rules

1. Inspect repository evidence before describing current behavior or proposing file-level changes.
2. Never invent file contents, schemas, APIs, environment variables, test results, production state, or third-party capabilities.
3. Never claim a command, test, migration, browser flow, or deployment succeeded without captured evidence.
4. If requirements, expected UX, credentials, source authorization, repository state, or production behavior are materially unclear, stop and ask one focused clarification question. Do not guess or continue past material uncertainty until the user answers.
5. Preserve user changes and unrelated dirty-worktree files. Never discard, overwrite, reset, or reformat unrelated work.
6. Never expose secrets, service-role keys, access tokens, resumes, offer letters, or private candidate data in output, logs, fixtures, commits, or screenshots.
7. Do not bypass ATS restrictions, anti-bot protections, source policies, consent requirements, or application authorization.
8. Use any relevant installed skills, MCPs, documentation tools, browser/testing tools, and project utilities when helpful. Choose them based on the task, state what was actually used, and never pretend a tool or skill was used.
9. Do not commit, push, deploy, run production migrations, change billing, or mutate production data without explicit authorization.

## Begin every task

Before editing:

1. Recommend the cheapest suitable available model and reasoning/effort level:
   - Fast/light model, low effort: file discovery, status checks, formatting, simple tests, and routine documentation.
   - Standard coding model, medium effort: focused features, normal bug fixes, UI work, adapters, and ordinary migrations.
   - Strongest available model, high effort: architecture, auth/RLS, payment logic, destructive migrations, concurrency, queue correctness, security incidents, and difficult cross-layer root causes.
2. Explain the recommendation in one sentence and downgrade after the risky work is complete.
3. Inspect only relevant context first: project instructions, current branch, `git status`, package manager, nearby source, schema/migrations, and related tests.
4. State the requested outcome, current evidence, uncertainty, and smallest safe mini-phase.

Conserve credits and context. Search before opening files, inspect narrow code ranges, avoid repeatedly reading unchanged files, and do not run the full test suite until focused checks pass.

## Source-of-truth order

When sources disagree, use this order:

1. Explicit current user instruction
2. Approved PRD and acceptance criteria
3. Repository code, migrations, tests, and configuration
4. Verified runtime and production evidence
5. Architecture and roadmap documents
6. Assumptions, which must be labeled and confirmed

Architecture documents are proposals until confirmed against the repository.

## Expected architecture contract

Verify these expectations before relying on them:

- React frontend and Express API
- Supabase Postgres, Auth, and Storage
- Drizzle ORM and additive SQL migrations
- Docker deployment on a single Hostinger VPS
- Existing job-source adapters and ingestion aggregator
- Resume extraction, cover-letter generation, review-and-send application flow
- Razorpay billing and monitoring integrations

Prefer additive evolution over rewrites or new infrastructure.

## Product invariants

- Candidate authorization controls every automated action.
- Candidate facts must remain factual and user-confirmed; never fabricate qualifications or application answers.
- Ingestion must remain available when trust scoring or company resolution is slow or unavailable.
- Every trust decision must be explainable through stable reason codes and evidence references.
- Auto-apply is allowed only for supported, authorized sources and eligible trust states.
- Submission must be idempotent and retain evidence without storing unnecessary sensitive data.
- Salary values from different source classes must remain separately labeled; never blend them into an unlabeled figure.
- Moderator and employer actions must be authorized, attributable, and auditable.
- India-first behavior, INR billing, and MCA resolution take priority; other regions are later scope unless explicitly requested.

## Mini-phase workflow

For every task, follow:

1. **Inspect** - locate the actual route, service, schema, callers, tests, and configuration.
2. **Reproduce or trace** - capture the failing behavior or trace the complete data path.
3. **Root cause** - distinguish the cause from symptoms and cite repository/runtime evidence.
4. **Plan** - propose the smallest reversible change and its acceptance checks.
5. **Implement** - change only approved scope; keep interfaces backward-compatible where practical.
6. **Focused verification** - run the narrowest relevant unit, integration, type, lint, or migration checks.
7. **Manual verification** - provide exact user-visible steps when browser, OAuth, payment, email, or production behavior needs confirmation.
8. **Diff review** - inspect changed files, secret exposure, generated files, lockfile changes, and migration safety.
9. **Approval gate** - request approval before commit, push, deployment, production migration, or irreversible action.

Do not combine unrelated phases merely to save time.

## Trust and moderation design

Use an explicit, versioned state machine. Prefer these states unless the existing schema or PRD requires different names:

```text
PENDING
SCORING
VERIFIED
UNDER_REVIEW
FLAGGED
BLOCKED
SCORING_FAILED
EXPIRED
```

Treat `jobs.trust_status` as a status/enum column, not a foreign key. Store normalized details separately, including score version, scored timestamp, reason codes, evidence, rule version, and moderator history.

Apply behavior:

| Trust state | Visible | Auto-apply |
| --- | --- | --- |
| VERIFIED | Yes | Only if source and candidate authorization also allow it |
| PENDING / SCORING | Yes, with checking state | No |
| UNDER_REVIEW / FLAGGED | Yes, with reasons | No |
| BLOCKED | Restricted or transparent blocked view | No |
| SCORING_FAILED | Yes, with retry/manual-review path | No |
| EXPIRED | Normally excluded from active results | No |

Hard blocks must be deterministic, testable, and reason-coded. Examples may include payment requests, verified domain mismatch, impersonation evidence, or prohibited MLM patterns. Do not block on ambiguous keyword matches alone without context and policy approval.

Trust scoring must be versioned and explainable. Record component scores separately for employer identity, source authority, URL integrity, freshness, salary plausibility, and other approved factors. Never silently change thresholds; migrations or configuration changes require tests and auditability.

When a verified job is reported or material evidence changes, enqueue re-scoring and immediately apply the approved safe interim state. Prevent stale `VERIFIED` values from bypassing moderation.

## Queue and worker rules

Use Postgres-backed asynchronous work to avoid Redis/Kafka infrastructure unless measured scale requires it.

Before adopting `pg-boss`, run a compatibility spike against the actual Supabase environment and connection method. Verify schema permissions, direct versus pooled connections, migrations, leases, retries, restart recovery, and operational visibility. If incompatible, use a minimal Postgres queue based on leases and `FOR UPDATE SKIP LOCKED` rather than adding Redis by default.

Initially run API and worker as separate processes/containers from the same image on the same VPS. Keep ingestion and apply request latency independent from trust scoring and company resolution.

Every job type must define:

- Versioned payload schema
- Idempotency key
- Maximum attempts and exponential backoff
- Lease/timeout behavior
- Retryable versus terminal errors
- Safe duplicate handling
- Failed-job visibility and manual retry
- Structured logs without sensitive payloads

Enqueue only after the related database transaction commits, or use an approved transactional outbox pattern. Workers must tolerate duplicate delivery.

## Company, reviews, and salary

- Resolve company identity separately from job records; do not equate a display name with a legal entity.
- Cache registry results with source, retrieval time, confidence, and raw-record provenance.
- Verify MCA API availability, licensing, rate limits, fields, and reliability against official documentation before implementation.
- Keep legal entities, domains, registry records, and employer claims separate.
- Store review verification separately from public review content.
- Enforce approved publication thresholds and privacy/redaction rules server-side.
- Preserve salary source labels such as employer-disclosed, government benchmark, verified observation, licensed estimate, and model estimate.
- Do not expose low-sample review identities or private verification evidence.

## Database and security rules

- Prefer additive migrations; never edit an already-applied production migration.
- Inspect current schema and migration history before writing SQL.
- Plan backfills, defaults, indexes, constraints, rollback/recovery, and mixed-version deployment behavior.
- Avoid long table locks and unsafe full-table rewrites.
- Test migrations on a production-like copy containing legacy data.
- Keep public user access under RLS and privileged server operations behind a narrowly scoped service boundary.
- Enforce moderator/admin authorization on the server; hiding UI controls is not authorization.
- Record immutable audit events for status changes, decisions, overrides, reports, appeals, and employer corrections.
- Test cross-user isolation, role escalation, object ownership, storage access, and IDOR/BOLA cases.
- Validate all external payloads and never trust client-supplied roles, prices, entitlements, trust decisions, or company verification.

## Authorized application engine

Before submission, verify all of the following atomically where possible:

- Candidate authorization is active and within configured limits
- Vacancy is fresh and not already applied to
- Source/channel is supported and authorized
- Trust state is eligible
- Required candidate facts are confirmed
- Entitlement/credit decision is server-authoritative
- Idempotency key prevents duplicate submission

Capture minimal submission evidence, provider response, timestamps, adapter version, and action-required state. Never mark an application successful from a UI click alone.

## Verification matrix

Choose relevant checks based on changed risk:

- Unit: rules, reason codes, scoring components, thresholds, state transitions
- Integration: database transactions, queue retries, idempotency, RLS, route authorization
- Adapter fixtures: normalization, freshness, deduplication, source evidence
- Browser: candidate flow, moderator console, badges, blocked actions, accessibility
- Migration: fresh database, legacy database, repeated execution, failure rollback
- Security: tenant isolation, privilege escalation, secret scan, dependency and input validation
- Deployment: health checks, worker recovery, migration order, image/SHA parity, rollback readiness

Never use production data in tests. Redact logs and screenshots.

## Completion report

End each mini-phase with:

```text
Outcome:
Evidence/root cause:
Files changed:
Commands actually run and exit codes:
Tests passed/failed/not run:
Skills/tools actually used:
Manual verification still required:
Risks or assumptions:
Recommended next mini-phase:
Recommended model and effort for the next session:
Why that model is sufficient:
When to upgrade or downgrade the model:
Approval needed before:
```

Recommend only a model that is actually available in the user's current Claude environment. If available model names are unknown, ask the user or recommend a capability tier such as fast/light, standard coding, or strongest available instead of inventing a model name. If a test was not run, say why. If evidence is incomplete, do not call the task production-ready.

## Deferred unless explicitly requested

- ML-based scam detection before enough labeled moderation history exists
- Redis, Kafka, Kubernetes, or separate infrastructure without measured need
- US/UK registry integrations before India-first launch requirements are complete
- Broad ATS automation that lacks documented authorization
- Large UI rewrites unrelated to the current acceptance criteria
- Production deployment or data migration without verified backup/recovery and approval
