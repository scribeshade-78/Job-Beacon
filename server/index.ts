import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
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
import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";
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
}

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
  const resolveServiceClient = () => options.serviceClient ?? createSupabaseServiceRoleClient();

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
