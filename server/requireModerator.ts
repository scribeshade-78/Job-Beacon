import type { NextFunction, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthenticatedRequest } from "./requireAuth.js";
import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";

/**
 * Server-side moderator check. This project has no request-scoped RLS
 * client (every server route uses the service-role client — see
 * worker.ts), so is_moderator() (SECURITY DEFINER, evaluated against
 * auth.uid()) isn't reachable from here; this queries user_roles directly
 * with a verified user id instead, the same authorization-in-application-
 * code pattern worker.ts already uses for discovery_allowed/kill_switch.
 *
 * The `client` default is lazy (evaluated only when this function is
 * actually called without one), mirroring verifyAccessToken's default
 * parameter in supabaseServer.ts — SUPABASE_SERVICE_ROLE_KEY isn't set in
 * every environment (confirmed: absent from .env here), so eagerly
 * constructing a service-role client at module load would break importing
 * this file at all in those environments.
 */
export async function isModerator(
  userId: string,
  client: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "moderator")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export type ModeratorChecker = typeof isModerator;

export function createRequireModerator(checkIsModerator: ModeratorChecker = isModerator) {
  return async function requireModerator(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!request.user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const moderator = await checkIsModerator(request.user.id);

    if (!moderator) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

export const requireModerator = createRequireModerator();
