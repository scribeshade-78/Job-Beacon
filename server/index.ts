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

  app.get(
    "/api/me",
    createRequireAuth(options.verifyAccessToken),
    async (request: AuthenticatedRequest, response) => {
      response.set("Cache-Control", "no-store");
      response.set("Vary", "Authorization");
      const userIsModerator = await checkIsModerator(request.user!.id);
      response.status(200).json({ ...request.user, isModerator: userIsModerator });
    },
  );

  app.use(express.json());

  const requireAuth = createRequireAuth(options.verifyAccessToken);
  const requireModerator = createRequireModerator(checkIsModerator);
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
