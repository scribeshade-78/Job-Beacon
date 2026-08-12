import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type VerifiedUser } from "./supabaseServer.js";

export interface AuthenticatedRequest extends Request {
  user?: VerifiedUser;
}

export type AccessTokenVerifier = (token: string) => Promise<VerifiedUser | null>;

/**
 * Extracts a single Bearer token from an Authorization header value.
 * Rejects anything malformed (missing, empty, wrong scheme, multiple/
 * comma-separated values, extra segments) without ever touching the network.
 */
export function parseBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  if (headerValue.includes(",")) {
    return null;
  }

  const parts = headerValue.trim().split(/\s+/);

  if (parts.length !== 2) {
    return null;
  }

  const [scheme, token] = parts;

  if (scheme.toLowerCase() !== "bearer") {
    return null;
  }

  if (!token || token.trim() === "") {
    return null;
  }

  return token;
}

export function createRequireAuth(verify: AccessTokenVerifier = verifyAccessToken) {
  return async function requireAuth(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = parseBearerToken(request.header("authorization"));

    if (!token) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const user = await verify(token);

    if (!user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    request.user = user;
    next();
  };
}

export const requireAuth = createRequireAuth();
