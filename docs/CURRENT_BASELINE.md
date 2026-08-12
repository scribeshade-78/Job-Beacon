# JobBeacon — Current Baseline

Recorded: 2026-08-12
Branch: `main`
Verified HEAD at time of writing: `ac1ff459ade125831a501a0cdd6dbcba43e431a9`

This document separates what is **verified by direct repository inspection** from what is **claimed by planning documents**, so the two are never blended into a single unlabeled statement of "current state."

---

## 1. Verified repository state

Directly observed in this repository at the HEAD above.

- `git status`: working tree clean apart from the untracked `docs/` directory (three PDFs) at the time this baseline was first drafted.
- `package.json` — `name: jobbeacon`, `version: 0.0.0`, `type: module`, `engines.node: >=22`.
- npm scripts: `dev`, `dev:client`, `dev:server`, `typecheck`, `test`, `build`, `build:client`, `build:server`, `preview`, `start`.
- Dependencies: `express`, `react`, `react-dom`.
- Dev dependencies: `@types/express`, `@types/node`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `concurrently`, `tsx`, `typescript`, `vite`, `vitest`.
- Source files present: `server/index.ts` (Express app, one route `/api/health`, static-file serving of `dist/client` if present), `server/index.test.ts` (2 Vitest cases: health check, 404 on unknown route), `client/index.html`, `client/src/App.tsx`, `client/src/main.tsx`, `client/src/styles.css`, `shared/app.ts`.
- No routes beyond `/api/health`. No database layer, no auth, no job-source adapters, no queue, no worker process, no admin surface.
- No `.env`, `.env.example`, or credential files present in the repository.
- No `.github/` directory and no `*.yml`/`*.yaml` files anywhere in the repository — CI configuration is absent.
- No Dockerfile, docker-compose file, or deploy script present.

This is the only implementation source of truth for "what currently works." Any document below that claims otherwise is describing a target, an estimate, or a different system — not this repository.

---

## 2. PRD v3.0 — target requirements (draft, not yet approved)

Source: `docs/JobBeacon_PRD_v3_Autonomous_Trust_Company_Intelligence.pdf` (31 pages, extracted cleanly, no errors).

**Status, as stated on the document itself: "Version 3.0 — Draft for Founder Approval."** It is not an approved specification. Per its own Document Control section, "material changes require founder approval and a version increment," and "every production-ready claim requires exact-head CI, deployment provenance, security evidence and founder acceptance."

The PRD describes a target product: candidate-authorized autonomous vacancy discovery, source-policy-governed ingestion, explainable trust scoring, fake-job hard blocks, moderation and appeals, separated company-intelligence dimensions, labeled salary sourcing, an autonomous application engine with idempotent submission, mailbox/response tracking, and India/US/EU regional billing.

None of this is implemented in the repository today. It is recorded here as **provisional target scope**, not as a description of current behavior. Any requirement drawn from it for planning purposes must remain labeled provisional until founder approval, per user-confirmed decision.

---

## 3. Development Roadmap — sequencing claims and stale assumptions

Source: `docs/JobBeacon_Development_Roadmap_Timeline.pdf` (5 pages, extracted cleanly, no errors).

Useful, provisionally, for **phase ordering and effort shape only** (Phase 0 baseline → R1–R7 → production certification, with a stated 28–45 working-day total estimate and a 6–9 week delivery window).

**Stale assumption — not true of this repository:** the roadmap states "the project already has a working React/Node application foundation, Supabase database/auth/storage, existing job-source integrations, OpenAI-based resume/cover-letter flows, Razorpay integration work, Sentry monitoring, and Docker/VPS deployment." Verified repository state (§1) contradicts this directly — none of those integrations exist here. This claim appears to originate from the separate implementation described in §4, not from this repository.

**Scope note:** the roadmap defines "Phase 0" as including "close existing high-priority gaps" (i.e., code changes). The explicit user instruction governing this session scoped Phase 0 to documentation and local-baseline stabilization only, with no application-code changes. Per confirmed precedence order (§5), the explicit instruction controls; the roadmap's broader Phase 0 definition does not apply to this session.

---

## 4. End-to-End Documentation — historical reference only

Source: `docs/JobBeacon End-to-End Documentation.pdf` (23 pages, extracted cleanly, no errors, doc version v1.0 dated 2026-08-04).

This file describes a **separate, already-live implementation built in a different tool/session**, with its own GitHub repository, its own deployment, and its own operational history. It is not evidence of this repository's current or past state and is not an implementation target.

The document also contains **plaintext credentials and other sensitive operational information** (a test-account password, an admin bypass passphrase, and infrastructure identifiers). For that reason:

- It is excluded from version control via `.gitignore` (`/docs/JobBeacon End-to-End Documentation.pdf`).
- It has not been staged or committed.
- No value from it has been reproduced in this document, in `PHASE_0_COMPLETION.md`, or in any command output during this session.
- No external system referenced in it (its Supabase project, VPS, Sentry, Razorpay, or any URL) was contacted during this session.
- **If the credentials in that document are still valid, rotating them is recommended** — this was not done and is outside the scope of this repository.

The local PDF itself was not modified.

---

## 5. User-confirmed decisions

- Repository contents at current HEAD are the source of truth for implementation state.
- Precedence order when documents disagree: explicit user instruction → verified repository state → PRD v3.0 (draft) → Development Roadmap (sequencing only) → End-to-End Documentation (historical reference only).
- The End-to-End Documentation PDF is excluded from Git via `.gitignore` and must never be staged.
- PRD v3.0 must not be described as missing; its status must be recorded accurately as "Version 3.0 — Draft for Founder Approval."
- Founder approval of the PRD is a future product-governance dependency, not a blocker to closing documentation-only Phase 0.
- The `jobbeacon-development` custom skill could not be invoked via the `Skill` tool this session (see §8) and was applied manually by reading its file directly.

---

## 6. Planned but unimplemented integrations

Per PRD v3.0 and the Roadmap, the following are **future scope, not present in the repository**: Supabase (Postgres, Auth, Storage), Drizzle ORM, candidate authentication, job-source ingestion adapters (Greenhouse/Lever/Ashby/Workable/Adzuna or others), OpenAI-based resume/cover-letter generation, Razorpay billing, Sentry monitoring, Docker packaging, and VPS deployment.

---

## 7. Local test/build baseline

Verified by direct command execution against HEAD `ac1ff459ade125831a501a0cdd6dbcba43e431a9` (see `PHASE_0_COMPLETION.md` for exact command transcripts and exit codes):

- `npm test` — passes (1 test file, 2 tests).
- `npm run typecheck` — passes (client and server TypeScript projects).
- `npm run build` — passes (client bundle + server compilation).

---

## 8. Deferred: CI/CD and production deployment

No CI configuration exists in this repository (no `.github/`, no workflow YAML). No Dockerfile, no deploy script, no production environment is configured or referenced from within this repository. This is an **approved deferral** for this phase, not a Phase 0 failure — CI/CD and production deployment are explicitly out of scope until a later phase.

Separately, and outside Phase 0 scope: the `.claude/skills/jobbeacon-development/SKILL.md` path in this repository's `.claude/` directory is a directory, not a file, so the skill definition it should contain (`JobBeacon_Claude_SKILL.md`) is not discoverable by the `Skill` tool. This is recorded as a project-tooling maintenance task for after Phase 0, not fixed in this mini-phase.
