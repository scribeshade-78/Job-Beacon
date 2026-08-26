import type { NextFunction, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthenticatedRequest } from "./requireAuth.js";
import { createSupabaseServiceRoleClient } from "./supabaseServiceRole.js";

/**
 * Server-side verified-employer check, scoped to one company. Mirrors
 * requireModerator.ts's isModerator exactly (this project has no
 * request-scoped RLS client; every server route uses the service-role
 * client), except employer identity is company-scoped (an employer_claims
 * row per (user, company)), not a flat global role, so this takes a
 * companyId rather than being a single yes/no check.
 */
export async function isVerifiedEmployerOf(
  userId: string,
  companyId: string,
  client: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from("employer_claims")
    .select("id")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .eq("status", "verified")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export type EmployerChecker = typeof isVerifiedEmployerOf;

/** R3.1-style UX signal for /api/me's isEmployer (any verified claim, not company-scoped) — the real authorization boundary stays createRequireEmployerOf below, same caveat isModerator's own comment already carries. */
export async function hasVerifiedEmployerClaim(
  userId: string,
  client: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<boolean> {
  const { data, error } = await client
    .from("employer_claims")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "verified")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}

export type HasVerifiedEmployerClaimChecker = typeof hasVerifiedEmployerClaim;

/**
 * PRD §20.1 "MFA-protected employer account" — enforced here, not only at
 * claim-review time: a verified claim alone isn't enough to reach an
 * employer route, the session itself must have completed an MFA challenge
 * (aal2). Returns a distinguishable {error: "mfa_required"} rather than a
 * generic 403 so the client can route to the existing SecurityPanel MFA
 * enrollment screen instead of a dead end.
 *
 * No R5.4a route wires this in yet — R5.4a only builds claim submission
 * and moderator review, neither of which is a company-scoped employer
 * action. This is the reusable gate R5.4b's corrections route (and later
 * R5.4c's appeal-filing route) will be the first to actually use — same
 * "schema/infra now, consuming route later" precedent this codebase
 * already uses repeatedly (vacancy_appeals, reverification_due_at).
 */
export function createRequireEmployerOf(
  getCompanyId: (request: AuthenticatedRequest) => string | undefined,
  checkIsVerifiedEmployer: EmployerChecker = isVerifiedEmployerOf,
) {
  return async function requireEmployerOf(
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!request.user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const companyId = getCompanyId(request);

    if (!companyId) {
      response.status(400).json({ error: "companyId is required" });
      return;
    }

    const verified = await checkIsVerifiedEmployer(request.user.id, companyId);

    if (!verified) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    if (request.user.aal !== "aal2") {
      response.status(403).json({ error: "mfa_required" });
      return;
    }

    next();
  };
}
