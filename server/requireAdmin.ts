import type { NextFunction, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthenticatedRequest } from "./requireAuth.js";
import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";

/**
 * Server-side admin check (R8.1). Mirrors requireModerator.ts's isModerator
 * exactly: this project has no request-scoped RLS client (every server
 * route uses the service-role client), so user_roles is queried directly
 * with a verified user id rather than through a SECURITY DEFINER helper.
 *
 * The `client` default is lazy (evaluated only when this function is
 * actually called without one) — same reasoning as isModerator's own
 * comment, SUPABASE_SERVICE_ROLE_KEY isn't set in every environment.
 */
export async function isAdmin(
  userId: string,
  client: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export type AdminChecker = typeof isAdmin;

export function createRequireAdmin(checkIsAdmin: AdminChecker = isAdmin) {
  return async function requireAdmin(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!request.user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const admin = await checkIsAdmin(request.user.id);

    if (!admin) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

export const requireAdmin = createRequireAdmin();
