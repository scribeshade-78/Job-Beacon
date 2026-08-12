import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, HEALTH_PATH, type HealthResponse } from "../shared/app.js";
import {
  createRequireAuth,
  type AccessTokenVerifier,
  type AuthenticatedRequest,
} from "./requireAuth.js";

export interface CreateAppOptions {
  verifyAccessToken?: AccessTokenVerifier;
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
