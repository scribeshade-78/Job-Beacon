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

export interface CreateAppOptions {
  verifyAccessToken?: AccessTokenVerifier;
  checkIsModerator?: ModeratorChecker;
  /** Injectable for tests; resolved lazily per-request otherwise (see each route) — never constructed eagerly, since SUPABASE_SERVICE_ROLE_KEY isn't set in every environment. */
  serviceClient?: SupabaseClient;
  /** Injectable for tests; resolved lazily per-request otherwise — never constructed eagerly, since OPENAI_API_KEY isn't set in every environment. */
  openaiClient?: Pick<OpenAI, "chat">;
  /** Injectable for tests; defaults to process.env.WORKER_TRIGGER_SECRET (MP-W2) — undefined means the route is unreachable (500), not open. */
  workerSecret?: string;
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

  app.get(
    "/api/me",
    createRequireAuth(options.verifyAccessToken),
    (request: AuthenticatedRequest, response) => {
      response.set("Cache-Control", "no-store");
      response.set("Vary", "Authorization");
      response.status(200).json(request.user);
    },
  );

  app.use(express.json());

  const requireAuth = createRequireAuth(options.verifyAccessToken);
  const requireModerator = createRequireModerator(options.checkIsModerator ?? isModerator);
  const requireWorkerSecret = createRequireWorkerSecret(options.workerSecret ?? process.env.WORKER_TRIGGER_SECRET);
  const resolveServiceClient = () => options.serviceClient ?? createSupabaseServiceRoleClient();
  const resolveOpenAIClient = () => options.openaiClient ?? createOpenAIClient();

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
      response.status(500).json({ error: message });
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
