/**
 * Server-side setup readiness (Phase 0 Task 2).
 *
 * WHY THE SERVER NEEDS ITS OWN EVALUATION. Hiding a button is not enforcement.
 * The client cannot be trusted to report its own readiness — a caller can post
 * to the queue endpoint directly — so the same rule the Home card renders is
 * re-derived here from authoritative rows and checked before anything is
 * enqueued.
 *
 * IT REUSES shared/readiness.ts RATHER THAN RESTATING THE RULE. A second copy of
 * "what counts as ready" is exactly how the UI and the backend drift into
 * disagreeing, which is the failure this task exists to remove.
 *
 * IT ADDS TO THE EXISTING GATES AND REPLACES NONE. Eligibility, source policy,
 * adapter support, duplicate prevention, consent-at-claim and review-before-submit
 * all still run; this only refuses to START work that the candidate has not
 * finished setting up.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateReadiness, type Readiness, type ReadinessBlockerCode } from "../../shared/readiness.js";
import { loadQueueCapability } from "./queueCapability.js";

/** The structured refusal a caller receives, so a client can act rather than parse prose. */
export interface ReadinessRefusal {
  code: ReadinessBlockerCode;
  message: string;
}

/**
 * Loads the readiness inputs for one candidate.
 *
 * FAIL CLOSED THROUGHOUT: a query error, a missing row or an unrecognised value
 * leaves the corresponding input at its not-ready value, so a database problem
 * can never be mistaken for a candidate having completed a step.
 */
export async function loadCandidateReadiness(
  client: SupabaseClient,
  candidateId: string,
): Promise<Readiness> {
  const [{ data: resumeRow }, { count: roleCount }, { data: preferenceRow }, { data: consentRow }, { data: profileRow }] =
    await Promise.all([
      client
        .from("resume_documents")
        .select("parse_status")
        .eq("candidate_id", candidateId)
        .eq("kind", "uploaded")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from("candidate_selected_roles")
        .select("role_name", { count: "exact", head: true })
        .eq("candidate_id", candidateId),
      client
        .from("candidate_preferences")
        .select("remote_preference, preferred_countries, preferred_cities, open_to_any_location")
        .eq("candidate_id", candidateId)
        .maybeSingle(),
      client
        .from("automation_authorizations")
        .select("status")
        .eq("candidate_id", candidateId)
        .maybeSingle(),
      client
        .from("candidate_profiles")
        .select("review_before_submit")
        .eq("id", candidateId)
        .maybeSingle(),
    ]);

  const capability = await loadQueueCapability(client);

  const preferences = preferenceRow as {
    remote_preference: string | null;
    preferred_countries: string[] | null;
    preferred_cities: string[] | null;
    open_to_any_location: boolean | null;
  } | null;

  return evaluateReadiness({
    resume: resumeRow ? { status: (resumeRow as { parse_status: unknown }).parse_status } : null,
    targetRoleCount: roleCount ?? 0,
    preferences: preferences
      ? {
          // Row existence IS the saved signal — see shared/readiness.ts.
          saved: true,
          remotePreference: preferences.remote_preference,
          countryCount: (preferences.preferred_countries ?? []).length,
          cityCount: (preferences.preferred_cities ?? []).length,
          openToAnyLocation: preferences.open_to_any_location,
        }
      : null,
    consentStatus: (consentRow as { status: unknown } | null)?.status ?? null,
    canQueue: capability.canQueue,
    reviewBeforeSubmit: (profileRow as { review_before_submit: boolean } | null)?.review_before_submit !== false,
    // No scheduled automation exists (verified in server/scheduler.ts), so this
    // is always false and 'active' is therefore unreachable — deliberately.
    scheduledAutomationRunning: false,
  });
}

/**
 * The setup blockers that must refuse a queue request, or an empty array when
 * the candidate is set up.
 *
 * ONLY THE FOUR SETUP STEPS ARE CHECKED HERE. Capability blockers
 * (supported_source_missing) are deliberately excluded: those are already
 * enforced per-vacancy by the eligibility gates, and refusing the whole request
 * for them would replace the existing, more informative per-job reasons with one
 * blanket error.
 */
export function setupRefusals(readiness: Readiness): ReadinessRefusal[] {
  if (readiness.setupComplete) {
    return [];
  }

  return readiness.blockers
    .filter((blocker) =>
      [
        "resume_missing",
        "resume_parsing",
        "resume_parse_failed",
        "target_roles_missing",
        "search_preferences_incomplete",
        "submission_consent_missing",
        "automation_paused",
        "automation_stopped",
      ].includes(blocker.code),
    )
    .map((blocker) => ({ code: blocker.code, message: blocker.message }));
}
