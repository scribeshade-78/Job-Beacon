import express from "express";
import rateLimit from "express-rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HEALTH_PATH, type HealthResponse } from "../shared/app.js";
import {
  createRequireAuth,
  type AccessTokenVerifier,
  type AuthenticatedRequest,
} from "./requireAuth.js";
import { createRequireModerator, isModerator, type ModeratorChecker } from "./requireModerator.js";
import { createRequireWorkerSecret } from "./requireWorkerSecret.js";
import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";
import { createOpenAIClient } from "./resumes/openaiClient.js";
import { extractResumeFacts } from "./resumes/extractFacts.js";
import { runApplicationBatch } from "./applications/runner.js";
import { runMessageClassificationBatch } from "./mailbox/classifyBatch.js";
import { runApplicationMatchBatch } from "./mailbox/matchBatch.js";
import { submitVacancyReport, REPORT_CATEGORIES, type ReportCategory } from "./reports.js";
import { getModerationQueue } from "./moderation/queue.js";
import {
  submitModerationDecision,
  ReviewerSeparationError,
  MODERATION_DECISIONS,
  type ModerationDecisionValue,
} from "./moderation/decisions.js";
import {
  startMailboxConnect,
  completeMailboxConnect,
  disconnectMailboxConnection,
  InvalidOAuthStateError,
  MailboxConnectionNotFoundError,
} from "./mailbox/connect.js";
import { readGoogleOAuthConfig, type GoogleOAuthConfig } from "./mailbox/oauth.js";
import { readMailboxEncryptionKey } from "./mailbox/tokenCrypto.js";
import {
  createRequireEmployerOf,
  hasVerifiedEmployerClaim,
  isVerifiedEmployerOf,
  type EmployerChecker,
  type HasVerifiedEmployerClaimChecker,
} from "./requireEmployer.js";
import {
  submitEmployerClaim,
  getEmployerClaimsQueue,
  submitEmployerClaimDecision,
  CompanyNotFoundError,
  EMPLOYER_CLAIM_DECISIONS,
  type EmployerClaimDecisionValue,
} from "./employer/claims.js";
import {
  submitCompanyFactCorrection,
  getCompanyFactCorrectionsQueue,
  submitCorrectionDecision,
  isCorrectableField,
  InvalidProposedValueError,
  UnverifiedEmployerError,
  CorrectionNotFoundError,
  CORRECTION_DECISIONS,
  type CorrectionDecisionValue,
} from "./employer/corrections.js";
import {
  listEmployerBlockedVacancies,
  submitVacancyAppeal,
  getAppealsQueue,
  UnverifiedEmployerError as UnverifiedEmployerAppealError,
  VacancyNotFoundError,
  DuplicatePendingAppealError,
} from "./employer/appeals.js";

export interface CreateAppOptions {
  verifyAccessToken?: AccessTokenVerifier;
  checkIsModerator?: ModeratorChecker;
  /** Injectable for tests; resolved lazily per-request otherwise (see each route) — never constructed eagerly, since SUPABASE_SERVICE_ROLE_KEY isn't set in every environment. */
  serviceClient?: SupabaseClient;
  /** Injectable for tests; resolved lazily per-request otherwise — never constructed eagerly, since OPENAI_API_KEY isn't set in every environment. */
  openaiClient?: Pick<OpenAI, "chat">;
  /** Injectable for tests; defaults to process.env.WORKER_TRIGGER_SECRET (MP-W2) — undefined means the route is unreachable (500), not open. */
  workerSecret?: string;
  /** Injectable for tests; resolved lazily per-request otherwise via readGoogleOAuthConfig() — undefined env vars mean the route 500s rather than silently misconfiguring the OAuth flow. */
  googleOAuthConfig?: GoogleOAuthConfig;
  /** Injectable for tests; defaults to process.env.MAILBOX_OAUTH_STATE_SECRET (R6.1) — signs/verifies the callback's `state` param. */
  mailboxOAuthStateSecret?: string;
  /** Injectable for tests; resolved lazily via readMailboxEncryptionKey() otherwise (R6.1) — the AES-256-GCM key mailbox OAuth tokens are encrypted under before storage. */
  mailboxEncryptionKey?: Buffer;
  /** Injectable for tests; defaults to process.env.CLIENT_APP_URL (R6.1) — base origin the OAuth callback redirects back to. Empty string is a valid default: in production the server serves the client from the same origin, so a relative redirect is correct. */
  mailboxClientAppUrl?: string;
  /** Injectable for tests (R5.4a) — same "server-verified UX signal only" role as checkIsModerator. */
  checkHasVerifiedEmployerClaim?: HasVerifiedEmployerClaimChecker;
  /** Injectable for tests (R5.4b) — the real per-company authorization boundary requireEmployerOf enforces. */
  checkIsVerifiedEmployer?: EmployerChecker;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  app.disable("x-powered-by");

  app.get(HEALTH_PATH, (_request, response) => {
    const body: HealthResponse = {
      status: "ok",
      service: APP_NAME,
    };

    response.status(200).json(body);
  });

  // R3.1: isModerator is included so the client can conditionally show
  // moderator-only navigation (e.g. the /moderator route) without a
  // separate round trip — the actual authorization boundary remains
  // server-side (requireModerator on every moderation route below), this
  // is a UX signal only, never trusted as an authorization decision itself.
  const checkIsModerator = options.checkIsModerator ?? isModerator;
  // R5.4a: same "UX signal only, never the authorization boundary itself"
  // caveat isModerator already carries — any *verified* claim, not scoped
  // to one company (createRequireEmployerOf is the real per-company gate).
  const checkHasVerifiedEmployerClaim = options.checkHasVerifiedEmployerClaim ?? hasVerifiedEmployerClaim;

  app.get(
    "/api/me",
    createRequireAuth(options.verifyAccessToken),
    async (request: AuthenticatedRequest, response) => {
      response.set("Cache-Control", "no-store");
      response.set("Vary", "Authorization");
      const userIsModerator = await checkIsModerator(request.user!.id);
      const userIsEmployer = await checkHasVerifiedEmployerClaim(request.user!.id);
      response.status(200).json({ ...request.user, isModerator: userIsModerator, isEmployer: userIsEmployer });
    },
  );

  app.use(express.json());

  const requireAuth = createRequireAuth(options.verifyAccessToken);
  const requireModerator = createRequireModerator(checkIsModerator);
  // R5.4b: requireEmployerOf's first real consumer — companyId comes from
  // the route param, same shape as requireModerator's global check but
  // scoped per-company.
  const requireEmployerOfCompanyParam = createRequireEmployerOf(
    (request) => request.params.companyId as string | undefined,
    options.checkIsVerifiedEmployer ?? isVerifiedEmployerOf,
  );
  // R5.4c: /api/employer/appeals has no companyId in its URL (the vacancy
  // implies it) — the client sends companyId in the body instead, gated
  // here the same way, then cross-checked again inside submitVacancyAppeal
  // against the vacancy's own company_id before anything is written.
  const requireEmployerOfCompanyBody = createRequireEmployerOf(
    (request) => (request.body as { companyId?: string } | undefined)?.companyId,
    options.checkIsVerifiedEmployer ?? isVerifiedEmployerOf,
  );
  const requireWorkerSecret = createRequireWorkerSecret(options.workerSecret ?? process.env.WORKER_TRIGGER_SECRET);
  const resolveServiceClient = () => options.serviceClient ?? createSupabaseServiceRoleClient();
  const resolveOpenAIClient = () => options.openaiClient ?? createOpenAIClient();
  const resolveGoogleOAuthConfig = () => options.googleOAuthConfig ?? readGoogleOAuthConfig();
  const resolveMailboxEncryptionKey = () => options.mailboxEncryptionKey ?? readMailboxEncryptionKey();
  const resolveMailboxOAuthStateSecret = () => {
    const secret = options.mailboxOAuthStateSecret ?? process.env.MAILBOX_OAUTH_STATE_SECRET;
    if (!secret) {
      throw new Error("Missing MAILBOX_OAUTH_STATE_SECRET.");
    }
    return secret;
  };
  const mailboxClientAppUrl = options.mailboxClientAppUrl ?? process.env.CLIENT_APP_URL ?? "";

  // Extraction calls a paid external API per request — rate-limited per
  // authenticated candidate (not per IP), so this only ever runs after
  // requireAuth has set request.user.
  const extractFactsRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (request: AuthenticatedRequest) => request.user!.id,
    message: { error: "Too many extraction requests. Please try again later." },
  });

  app.post("/api/vacancies/:vacancyId/reports", requireAuth, async (request: AuthenticatedRequest, response) => {
    const { category, description } = request.body ?? {};

    if (!REPORT_CATEGORIES.includes(category)) {
      response.status(400).json({ error: `category must be one of: ${REPORT_CATEGORIES.join(", ")}` });
      return;
    }

    try {
      const result = await submitVacancyReport(resolveServiceClient(), {
        vacancyId: request.params.vacancyId as string,
        reporterId: request.user!.id,
        category: category as ReportCategory,
        description: typeof description === "string" ? description : undefined,
      });
      response.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/resumes/:id/extract",
    requireAuth,
    extractFactsRateLimit,
    async (request: AuthenticatedRequest, response) => {
      if (!UUID_PATTERN.test(request.params.id as string)) {
        response.status(400).json({ error: "id must be a valid resume id." });
        return;
      }

      try {
        const result = await extractResumeFacts(resolveServiceClient(), resolveOpenAIClient(), {
          resumeId: request.params.id as string,
          candidateId: request.user!.id,
        });

        switch (result.kind) {
          case "success":
            response.status(201).json({ facts: result.facts });
            return;
          case "not_found":
            response.status(404).json({ error: "Resume not found." });
            return;
          case "unsupported_format":
            response.status(422).json({ error: "This resume's file format isn't supported for extraction." });
            return;
          case "malformed_extraction":
            response.status(422).json({ error: result.message });
            return;
          case "error":
            response.status(500).json({ error: result.message });
            return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  app.get("/api/moderation/queue", requireAuth, requireModerator, async (_request, response) => {
    try {
      const queue = await getModerationQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/moderation/cases/:caseId/decisions",
    requireAuth,
    requireModerator,
    async (request: AuthenticatedRequest, response) => {
      const { decision, rationale, policyVersion, appealId } = request.body ?? {};

      if (!MODERATION_DECISIONS.includes(decision)) {
        response.status(400).json({ error: `decision must be one of: ${MODERATION_DECISIONS.join(", ")}` });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      if (typeof policyVersion !== "string" || policyVersion.trim() === "") {
        response.status(400).json({ error: "policyVersion is required" });
        return;
      }

      try {
        const result = await submitModerationDecision(resolveServiceClient(), {
          caseId: request.params.caseId as string,
          reviewerId: request.user!.id,
          decision: decision as ModerationDecisionValue,
          rationale,
          policyVersion,
          appealId: typeof appealId === "string" ? appealId : undefined,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof ReviewerSeparationError) {
          response.status(409).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R6.1: starts the Gmail connect handshake — mints a signed `state` and
  // hands back the Google consent URL for the client to navigate to.
  app.post("/api/mailbox/connect/start", requireAuth, (request: AuthenticatedRequest, response) => {
    try {
      const { authorizeUrl } = startMailboxConnect(
        request.user!.id,
        resolveGoogleOAuthConfig(),
        resolveMailboxOAuthStateSecret(),
      );
      response.status(200).json({ authorizeUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  // R6.1: Google redirects the browser here directly — a top-level
  // navigation, so it carries no Authorization header and can't go through
  // requireAuth. Identity is instead proven by the signed `state` param
  // (see oauthState.ts). Always ends in a redirect, success or failure —
  // there's no JSON client waiting on this response.
  app.get("/api/mailbox/oauth/callback", async (request, response) => {
    const redirectTo = (status: "connected" | "error") => `${mailboxClientAppUrl}/?mailbox=${status}#/responses`;

    const { code, state, error: oauthError } = request.query;

    if (typeof oauthError === "string" || typeof code !== "string" || typeof state !== "string") {
      response.redirect(redirectTo("error"));
      return;
    }

    try {
      await completeMailboxConnect(
        resolveServiceClient(),
        resolveGoogleOAuthConfig(),
        resolveMailboxOAuthStateSecret(),
        resolveMailboxEncryptionKey(),
        { code, state },
      );
      response.redirect(redirectTo("connected"));
    } catch (error) {
      if (!(error instanceof InvalidOAuthStateError)) {
        console.error("Mailbox OAuth callback failed:", error instanceof Error ? error.message : error);
      }
      response.redirect(redirectTo("error"));
    }
  });

  app.post(
    "/api/mailbox/:id/disconnect",
    requireAuth,
    async (request: AuthenticatedRequest, response) => {
      if (!UUID_PATTERN.test(request.params.id as string)) {
        response.status(400).json({ error: "id must be a valid mailbox connection id." });
        return;
      }

      try {
        const result = await disconnectMailboxConnection(
          resolveServiceClient(),
          { connectionId: request.params.id as string, candidateId: request.user!.id },
          resolveMailboxEncryptionKey(),
        );
        response.status(200).json(result);
      } catch (error) {
        if (error instanceof MailboxConnectionNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4a: how a candidate becomes an employer — requireAuth only, not
  // requireEmployer (nothing to gate yet; submitting a claim is how you
  // get one). domainVerified is computed server-side inside
  // submitEmployerClaim from request.user!.email, never client-supplied.
  app.post("/api/employer/claims", requireAuth, async (request: AuthenticatedRequest, response) => {
    const { companyId, representativeName, representativeRole, evidence } = request.body ?? {};

    if (typeof companyId !== "string" || companyId.trim() === "") {
      response.status(400).json({ error: "companyId is required" });
      return;
    }

    if (typeof representativeName !== "string" || representativeName.trim() === "") {
      response.status(400).json({ error: "representativeName is required" });
      return;
    }

    if (typeof representativeRole !== "string" || representativeRole.trim() === "") {
      response.status(400).json({ error: "representativeRole is required" });
      return;
    }

    try {
      const result = await submitEmployerClaim(resolveServiceClient(), {
        userId: request.user!.id,
        userEmail: request.user!.email,
        companyId,
        representativeName,
        representativeRole,
        evidence: typeof evidence === "string" ? evidence : undefined,
      });
      response.status(201).json(result);
    } catch (error) {
      if (error instanceof CompanyNotFoundError) {
        response.status(404).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.get("/api/moderation/employer-claims", requireAuth, requireModerator, async (_request, response) => {
    try {
      const queue = await getEmployerClaimsQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/moderation/employer-claims/:claimId/decision",
    requireAuth,
    requireModerator,
    async (request: AuthenticatedRequest, response) => {
      const { decision, rationale } = request.body ?? {};

      if (!EMPLOYER_CLAIM_DECISIONS.includes(decision)) {
        response.status(400).json({ error: `decision must be one of: ${EMPLOYER_CLAIM_DECISIONS.join(", ")}` });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      try {
        const result = await submitEmployerClaimDecision(resolveServiceClient(), {
          claimId: request.params.claimId as string,
          reviewerId: request.user!.id,
          decision: decision as EmployerClaimDecisionValue,
          rationale,
        });
        response.status(201).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4b: requireEmployerOfCompanyParam's first route — companyId comes
  // from the URL, so both the "does a verified claim exist" check and the
  // AAL2 check happen before any body parsing/validation below runs.
  app.post(
    "/api/employer/companies/:companyId/corrections",
    requireAuth,
    requireEmployerOfCompanyParam,
    async (request: AuthenticatedRequest, response) => {
      const { fieldName, proposedValue, evidence } = request.body ?? {};

      if (typeof fieldName !== "string" || !isCorrectableField(fieldName)) {
        response.status(400).json({ error: "fieldName must be one of the correctable fields." });
        return;
      }

      if (typeof proposedValue !== "string" || proposedValue.trim() === "") {
        response.status(400).json({ error: "proposedValue is required" });
        return;
      }

      try {
        const result = await submitCompanyFactCorrection(resolveServiceClient(), {
          userId: request.user!.id,
          companyId: request.params.companyId as string,
          fieldName,
          proposedValue,
          evidence: typeof evidence === "string" ? evidence : undefined,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof InvalidProposedValueError) {
          response.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof UnverifiedEmployerError) {
          response.status(403).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  app.get("/api/moderation/company-corrections", requireAuth, requireModerator, async (_request, response) => {
    try {
      const queue = await getCompanyFactCorrectionsQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  app.post(
    "/api/moderation/company-corrections/:correctionId/decision",
    requireAuth,
    requireModerator,
    async (request: AuthenticatedRequest, response) => {
      const { decision, rationale } = request.body ?? {};

      if (!CORRECTION_DECISIONS.includes(decision)) {
        response.status(400).json({ error: `decision must be one of: ${CORRECTION_DECISIONS.join(", ")}` });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      try {
        const result = await submitCorrectionDecision(resolveServiceClient(), {
          correctionId: request.params.correctionId as string,
          reviewerId: request.user!.id,
          decision: decision as CorrectionDecisionValue,
          rationale,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof CorrectionNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4c: which of this employer's vacancies are currently blocked, and
  // why — moderation_cases/moderation_decisions are service_role-only (no
  // authenticated grant at all), so this can't be an RLS-direct client
  // read the way listMyEmployerClaims is.
  app.get(
    "/api/employer/companies/:companyId/blocked-vacancies",
    requireAuth,
    requireEmployerOfCompanyParam,
    async (request: AuthenticatedRequest, response) => {
      try {
        const entries = await listEmployerBlockedVacancies(resolveServiceClient(), request.params.companyId as string);
        response.status(200).json(entries);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  app.post(
    "/api/employer/appeals",
    requireAuth,
    requireEmployerOfCompanyBody,
    async (request: AuthenticatedRequest, response) => {
      const { companyId, vacancyId, rationale, evidence } = request.body ?? {};

      if (typeof vacancyId !== "string" || vacancyId.trim() === "") {
        response.status(400).json({ error: "vacancyId is required" });
        return;
      }

      if (typeof rationale !== "string" || rationale.trim() === "") {
        response.status(400).json({ error: "rationale is required" });
        return;
      }

      try {
        const result = await submitVacancyAppeal(resolveServiceClient(), {
          userId: request.user!.id,
          companyId: companyId as string,
          vacancyId,
          rationale,
          evidence: typeof evidence === "string" ? evidence : undefined,
        });
        response.status(201).json(result);
      } catch (error) {
        if (error instanceof UnverifiedEmployerAppealError) {
          response.status(403).json({ error: error.message });
          return;
        }
        if (error instanceof VacancyNotFoundError) {
          response.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof DuplicatePendingAppealError) {
          response.status(409).json({ error: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      }
    },
  );

  // R5.4c: resolving an appeal reuses POST /api/moderation/cases/:caseId/decisions
  // unchanged — the moderator submits a decision against the appeal case's
  // own id with appealId set, which that route already accepted (R6.1-era
  // code, unused until now). No new decision-writing route needed.
  app.get("/api/moderation/appeals", requireAuth, requireModerator, async (_request, response) => {
    try {
      const queue = await getAppealsQueue(resolveServiceClient());
      response.status(200).json(queue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: message });
    }
  });

  // MP-W2: triggers the MP-W1 batch entrypoint (same runApplicationBatch
  // npm run worker:applications already calls) over HTTP, for an external
  // scheduler (cron) rather than a signed-in candidate/moderator — see
  // requireWorkerSecret.ts for why this isn't requireAuth/requireModerator
  // or the raw service-role key. runApplicationBatch's own idempotency
  // (getOrCreatePlan) and leasing (claim_application_attempt's FOR UPDATE
  // SKIP LOCKED) already make overlapping/concurrent triggers safe, so no
  // additional "already running" guard is added here.
  app.post("/api/worker/run", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runApplicationBatch(resolveServiceClient());
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Worker run failed:", message);
      response.status(500).json({ error: "Failed to run application batch" });
    }
  });

  // R6.3 Response Intelligence: backfill/retry classification of stored
  // messages, for the same external scheduler as /api/worker/run. Fresh
  // mail is classified inline during the mailbox poll; this drains the
  // backlog and anything the poll couldn't classify.
  app.post("/api/worker/classify-messages", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runMessageClassificationBatch(resolveServiceClient(), resolveOpenAIClient());
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Message classification run failed:", message);
      response.status(500).json({ error: "Failed to run message classification batch" });
    }
  });

  // R6.3 Response Intelligence Phase 3: link classified-but-unlinked
  // messages to the owning candidate's application attempts. Runs after
  // /api/worker/classify-messages on the same external scheduler; safe to
  // re-run (only touches messages whose application_attempt_id IS NULL).
  app.post("/api/worker/match-messages", requireWorkerSecret, async (_request, response) => {
    try {
      const result = await runApplicationMatchBatch(resolveServiceClient());
      response.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Message match run failed:", message);
      response.status(500).json({ error: "Failed to run message match batch" });
    }
  });

  const clientBuildPath = path.resolve(process.cwd(), "dist/client");

  if (existsSync(clientBuildPath)) {
    app.use(express.static(clientBuildPath));
  }

  return app;
}

const port = Number.parseInt(process.env.PORT ?? "5000", 10);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = createApp();

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  app.listen(port, host, () => {
    console.log(`${APP_NAME} server listening at http://${host}:${port}`);
  });
}

export { app };
