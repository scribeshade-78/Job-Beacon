import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { parseBearerToken } from "./requireAuth.js";

/**
 * MP-W2: protects POST /api/worker/run, which is invoked by an external
 * scheduler (cron), not a signed-in candidate/moderator — requireAuth and
 * requireModerator both need a real Supabase session, which a scheduler has
 * none of. Deliberately not the SUPABASE_SERVICE_ROLE_KEY either: that key
 * bypasses RLS on every table, a far bigger blast radius than this route
 * needs (it can only trigger one batch function) if it ever leaked via a
 * cron system's logs/dashboard. A single-purpose secret keeps the leak
 * blast radius to "someone can trigger a batch run" — already idempotent
 * and rate-controlled, nothing else.
 *
 * timingSafeEqual requires equal-length buffers (throws otherwise), so
 * length is checked first — a length mismatch is itself just "not equal",
 * not an error case worth distinguishing from any other wrong secret.
 */
function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

export function createRequireWorkerSecret(secret: string | undefined = process.env.WORKER_TRIGGER_SECRET) {
  return function requireWorkerSecret(request: Request, response: Response, next: NextFunction): void {
    if (!secret) {
      response.status(500).json({ error: "Worker trigger is not configured." });
      return;
    }

    const token = parseBearerToken(request.header("authorization"));

    if (!token || !safeCompare(token, secret)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
