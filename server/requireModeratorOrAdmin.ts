import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./requireAuth.js";
import { isModerator, type ModeratorChecker } from "./requireModerator.js";
import { isAdmin, type AdminChecker } from "./requireAdmin.js";

/**
 * R8.1: admins reach the existing /api/moderation/* routes too, rather than
 * duplicating each one under /api/admin/moderation/*. Checks moderator
 * first (the existing, unchanged path) and only checks admin if that's
 * false, so a moderator-only request never touches the admin checker at
 * all — existing moderator-gated route tests are unaffected.
 */
export function createRequireModeratorOrAdmin(
  checkIsModerator: ModeratorChecker = isModerator,
  checkIsAdmin: AdminChecker = isAdmin,
) {
  return async function requireModeratorOrAdmin(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!request.user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const authorized = (await checkIsModerator(request.user.id)) || (await checkIsAdmin(request.user.id));

    if (!authorized) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}
