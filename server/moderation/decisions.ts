import type { SupabaseClient } from "@supabase/supabase-js";

/** Matches the moderation_decisions.decision check constraint exactly (§19.1). */
export const MODERATION_DECISIONS = ["cleared", "flagged", "blocked", "request_info", "escalated"] as const;

export type ModerationDecisionValue = (typeof MODERATION_DECISIONS)[number];

export interface SubmitModerationDecisionInput {
  caseId: string;
  reviewerId: string;
  decision: ModerationDecisionValue;
  rationale: string;
  policyVersion: string;
  appealId?: string;
}

export interface SubmitModerationDecisionResult {
  id: string;
}

/** Thrown when the DB's reviewer-separation trigger rejects the insert — the route layer maps this to 409, not a generic 500. */
export class ReviewerSeparationError extends Error {}

/**
 * reviewerId must come from the verified session (request.user.id), never
 * from client-supplied input — a moderator can only ever record a decision
 * as themselves. The DB's WITH CHECK policy and reviewer-separation
 * trigger both hold regardless, but this route uses the service-role
 * client (server routes have no request-scoped RLS client in this
 * project — see requireModerator.ts), which bypasses RLS entirely, so the
 * server must not rely on RLS alone for this specific guarantee.
 */
export async function submitModerationDecision(
  client: SupabaseClient,
  input: SubmitModerationDecisionInput,
): Promise<SubmitModerationDecisionResult> {
  const { data, error } = await client
    .from("moderation_decisions")
    .insert({
      moderation_case_id: input.caseId,
      reviewer_id: input.reviewerId,
      decision: input.decision,
      rationale: input.rationale,
      policy_version: input.policyVersion,
      appeal_id: input.appealId ?? null,
    })
    .select("id")
    .single();

  if (error) {
    // The reviewer-separation trigger raises a plain PL/pgSQL exception
    // (SQLSTATE P0001, the default for RAISE EXCEPTION with no explicit
    // ERRCODE) — translate it to a typed error instead of a generic 500.
    if ((error as { code?: string }).code === "P0001") {
      throw new ReviewerSeparationError(error.message);
    }
    throw error;
  }

  if (!data) {
    throw new Error("Failed to insert moderation_decisions row — no row returned.");
  }

  return { id: (data as { id: string }).id };
}
