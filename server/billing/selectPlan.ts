import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PLAN_CODE, type BillingRegion } from "../../shared/pricing.js";
import { applyCheckoutCompleted, cancelCandidateSubscription } from "./subscription.js";

/**
 * Task R5 — the early-access plan switch.
 *
 * WHAT THIS IS, PLAINLY. This writes a LIVE subscription with
 * provider = 'manual' and takes NO MONEY. A candidate who calls it is on Pro
 * immediately and is charged nothing. That is a deliberate pre-launch decision,
 * not an oversight, and the UI says so in the confirmation dialog in those
 * words. It exists because the product should be usable before a payment
 * provider is wired, and because 'manual' is a provider the schema already has
 * for exactly this: "an operator granting a plan without a payment provider".
 *
 * WHAT KEEPS IT FROM BEING A WIDER HOLE THAN IT LOOKS:
 *   * The candidate id comes from the verified token, never the request body, so
 *     this can only ever change the caller's own plan.
 *   * It is unreachable from the Copilot and from every worker — it has exactly
 *     one caller, POST /api/billing/select-plan.
 *   * Every activation is audited.
 *   * It is only OFFERED when the region's real provider is unconfigured. Once
 *     Razorpay or Stripe keys are present the UI routes to Checkout instead, and
 *     a route guard refuses this path in that case, so the fallback closes
 *     itself the moment it is no longer needed.
 *
 * FREE IS NOT A 'manual' GRANT. Selecting Free has to CLOSE the live row, and
 * cancelCandidateSubscription already knows how: a row with a paid period is
 * scheduled to end, and a row without one — which is what a manual grant looks
 * like — is closed immediately.
 */

export type SelectPlanResult =
  | { kind: "activated"; planCode: string; subscriptionId: string }
  | { kind: "downgraded" }
  | { kind: "unknown_plan"; planCode: string }
  | { kind: "failed"; message: string };

export async function selectCandidatePlan(
  client: SupabaseClient,
  input: { candidateId: string; planCode: string; region: BillingRegion; currency: string },
): Promise<SelectPlanResult> {
  if (input.planCode === DEFAULT_PLAN_CODE) {
    try {
      // "no_subscription" is the same outcome as a cancellation here: the
      // candidate asked to be on Free and they are on Free either way, so it is
      // reported as a successful downgrade rather than as a failure.
      await cancelCandidateSubscription(client, input.candidateId);

      return { kind: "downgraded" };
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  // Wrapped for the same reason the Free path is: this module's contract is a
  // discriminated result, never a throw, so a database failure is a value the
  // route can map rather than an exception it has to guess at.
  try {
    const result = await applyCheckoutCompleted(client, {
      candidateId: input.candidateId,
      planCode: input.planCode,
      provider: "manual",
      // A manual grant has no provider identifiers, which is precisely why those
      // columns are nullable.
      providerCustomerId: null,
      providerSubscriptionId: null,
      region: input.region,
      currency: input.currency,
      billingInterval: "month",
      // NO PERIOD. A grant with no period end is one that
      // cancelCandidateSubscription closes immediately, which is the honest
      // behaviour for something nobody paid for — there is no paid remainder to
      // honour.
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });

    if (result.kind === "unknown_plan") {
      return { kind: "unknown_plan", planCode: result.planCode };
    }

    return { kind: "activated", planCode: input.planCode, subscriptionId: result.subscriptionId };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
