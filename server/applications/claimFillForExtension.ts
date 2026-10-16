import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadExtensionProfile, type ExtensionProfile } from "../extension/profile.js";
import { decideFillClaim, type ClaimContext, type Decision } from "./claimDecision.js";
import { evaluateEligibilityGates, type EligibilityGateOutcome } from "./eligibilityGate.js";

/**
 * TRIP 1: claim an attempt for filling, and hand the extension the credentials Trip 2 needs.
 *
 * THIS CANNOT BE A READ, WHICH IS WHY IT EXISTS AS ITS OWN MODULE. authorizeSubmission
 * requires an attemptId AND a leaseToken; lease tokens are minted server-side by the claim
 * path and nothing in the product hands one to a client. A read-only fill endpoint would
 * return the data, the candidate would review it, and Trip 2 would have no credential to
 * present - a loop that looks complete and can never submit anything.
 *
 * IT DOES NOT AUTHORIZE A SUBMISSION. Minting a lease says "this worker may prepare a form
 * for this attempt". It grants nothing about sending one: authorizeSubmission re-runs every
 * gate, re-checks the lease, and requires review approval before anything is sent. That
 * separation is the whole two-trip design, and a lease is deliberately not a permission.
 *
 * THE ORDER IS THE DESIGN, as in the gatekeeper:
 *   1. ownership from ROWS, never from the request
 *   2. the gates, through the shared evaluator - not one is re-implemented here
 *   3. the pure decision
 *   4. ONE conditional update mints the lease, and ZERO ROWS is the refusal
 */

export interface ClaimFillInput {
  candidateId: string;
  /** Which attempt to prepare a form for. */
  attemptId: string;
  now?: () => Date;
}

/** Everything the extension needs to populate a form. */
export interface ExtensionFill {
  candidateId: string;
  vacancyId: string;
  profile: ExtensionProfile;
}

export type ClaimFillResult =
  | { allowed: true; attemptId: string; leaseToken: string; fill: ExtensionFill }
  | { allowed: false; refusal: string; gate?: string; reasonCode?: string };

interface AttemptRow {
  id: string;
  application_plan_id: string;
  status: string;
  lease_token: string | null;
  leased_until: string | null;
}

interface PlanRow {
  id: string;
  vacancy_id: string;
  candidate_id: string;
}

/**
 * LONG ENOUGH FOR A HUMAN, SHORT ENOUGH TO SELF-HEAL.
 *
 * A lease has to outlive the candidate reading a form and deciding, which is minutes rather
 * than seconds. Fifteen minutes covers that with room to spare, and an abandoned attempt
 * becomes claimable again on its own - the conditional update below accepts a lease whose
 * time has passed, so a crashed extension does not strand an application forever.
 */
const LEASE_MINUTES = 15;

export async function claimFillForExtension(
  client: SupabaseClient,
  input: ClaimFillInput,
  loadGates: (client: SupabaseClient, ids: { candidateId: string; vacancyId: string }) => Promise<EligibilityGateOutcome> =
    evaluateEligibilityGates,
): Promise<ClaimFillResult> {
  const now = input.now ?? (() => new Date());
  const stamp = now();

  // 1. Load the attempt and its plan. Ownership comes from rows.
  const { data: attemptData, error: attemptError } = await client
    .from("application_attempts")
    .select("id, application_plan_id, status, lease_token, leased_until")
    .eq("id", input.attemptId)
    .maybeSingle();

  if (attemptError) {
    throw attemptError;
  }

  const attempt = attemptData as AttemptRow | null;
  if (!attempt) {
    return { allowed: false, refusal: "NOT_FOUND" };
  }

  const { data: planData, error: planError } = await client
    .from("application_plans")
    .select("id, vacancy_id, candidate_id")
    .eq("id", attempt.application_plan_id)
    .maybeSingle();

  if (planError) {
    throw planError;
  }

  const plan = planData as PlanRow | null;

  // "Not yours" and "does not exist" answer identically, so this cannot be used to probe
  // for other people's attempts.
  if (!plan || plan.candidate_id !== input.candidateId) {
    return { allowed: false, refusal: "NOT_FOUND" };
  }

  // 2. The gates, from the shared evaluator.
  const outcome = await loadGates(client, {
    candidateId: input.candidateId,
    vacancyId: plan.vacancy_id,
  });

  const { data: profileData, error: profileError } = await client
    .from("candidate_profiles")
    .select("review_before_submit")
    .eq("id", input.candidateId)
    .maybeSingle();

  if (profileError) {
    throw profileError;
  }

  const reviewBeforeSubmit =
    (profileData as { review_before_submit: boolean | null } | null)?.review_before_submit === true;

  const context: ClaimContext = {
    gates: outcome.gates,
    reviewBeforeSubmit,
    attemptStatus: attempt.status,
  };

  // 3. The pure decision. The same function the tests enumerate gate by gate.
  const decision: Decision = decideFillClaim(context);

  if (!decision.allowed) {
    return { allowed: false, refusal: decision.refusal, gate: decision.gate, reasonCode: decision.reasonCode };
  }

  // 4. Mint the lease. ONE conditional update, mirroring consumeSubmission: every condition
  //    is in the WHERE clause, so there is no read-then-write window for two callers.
  const leaseToken = randomUUID();
  const leasedUntil = new Date(stamp.getTime() + LEASE_MINUTES * 60_000).toISOString();

  const { data: leased, error: leaseError } = await client
    .from("application_attempts")
    .update({
      status: "leased",
      // THE MARK THAT KEEPS THE UNATTENDED WORKER OFF THIS ROW. A human is about to read and
      // submit a real form, which takes as long as it takes; claim_application_attempt refuses
      // leased_by = 'extension' at every age, so no 15-minute clock can hand this attempt to the
      // server worker while the browser is still filling it. See 20261017120000.
      leased_by: "extension",
      lease_token: leaseToken,
      leased_until: leasedUntil,
      updated_at: stamp.toISOString(),
    })
    .eq("id", attempt.id)
    // Only a claimable status may be leased.
    .in("status", ["pending", "pending_review"])
    // And only if nobody else holds a LIVE lease. An expired one is claimable again.
    .or("lease_token.is.null,leased_until.lt." + stamp.toISOString())
    .select("id")
    .maybeSingle();

  if (leaseError) {
    throw leaseError;
  }

  // ZERO ROWS IS THE REFUSAL, and it covers every racing case at once: another worker
  // claimed it between our read and our write, or the status moved underneath us.
  if (!leased) {
    return { allowed: false, refusal: "ALREADY_CLAIMED" };
  }

  const profile = await loadExtensionProfile(client, input.candidateId);

  return {
    allowed: true,
    attemptId: attempt.id,
    leaseToken,
    fill: {
      candidateId: input.candidateId,
      vacancyId: plan.vacancy_id,
      profile,
    },
  };
}
