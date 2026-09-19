import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingInterval } from "./plans.js";

/**
 * Task H1 — subscription state for one candidate.
 *
 * There is at most one live row per candidate (partial unique index
 * subscriptions_one_live_per_candidate_idx), so "the candidate's subscription"
 * is a well-defined question and these functions never have to choose between
 * two rows.
 *
 * WRITES ARE TRANSITIONS, NOT UPSERTS OF WHATEVER THE CALLER SENT. A candidate
 * cannot write this table at all — there is no INSERT/UPDATE grant to
 * authenticated — and the only writer is service_role behind a verified Stripe
 * webhook or an explicit admin action. That is the whole reason a subscription
 * row can be trusted as evidence of payment.
 */

export const LIVE_SUBSCRIPTION_STATUSES = ["incomplete", "trialing", "active", "past_due", "unpaid"] as const;

export interface CandidateSubscription {
  id: string;
  planCode: string;
  planDisplayName: string;
  provider: string;
  status: string;
  region: string;
  currency: string;
  billingInterval: BillingInterval;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface SubscriptionRow {
  id: string;
  plan_id: string;
  provider: string;
  status: string;
  region: string;
  currency: string;
  billing_interval: BillingInterval;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

/** The candidate's live subscription, or null when they have none. */
export async function getCandidateSubscription(
  client: SupabaseClient,
  candidateId: string,
): Promise<CandidateSubscription | null> {
  const { data, error } = await client
    .from("subscriptions")
    .select("id, plan_id, provider, status, region, currency, billing_interval, current_period_start, current_period_end, cancel_at_period_end")
    .eq("candidate_id", candidateId)
    .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const row = data as SubscriptionRow;

  const { data: plan, error: planError } = await client
    .from("subscription_plans")
    .select("code, display_name")
    .eq("id", row.plan_id)
    .single();

  if (planError) {
    throw planError;
  }

  return {
    id: row.id,
    planCode: (plan as { code: string }).code,
    planDisplayName: (plan as { display_name: string }).display_name,
    provider: row.provider,
    status: row.status,
    region: row.region,
    currency: row.currency,
    billingInterval: row.billing_interval,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

export type CancelResult =
  | { kind: "canceled"; subscription: CandidateSubscription }
  | { kind: "no_subscription" };

/**
 * Cancels the candidate's live subscription.
 *
 * A subscription with a period end is scheduled to end rather than cut off
 * immediately (cancel_at_period_end), because the candidate has paid for the
 * remainder of the period and revoking it early would take money for time not
 * served. A row with no period end — which is what a manual grant looks like —
 * is closed immediately, since there is no paid remainder to honour.
 */
export async function cancelCandidateSubscription(
  client: SupabaseClient,
  candidateId: string,
): Promise<CancelResult> {
  const current = await getCandidateSubscription(client, candidateId);

  if (!current) {
    return { kind: "no_subscription" };
  }

  const scheduled = current.currentPeriodEnd !== null;

  const { error } = await client
    .from("subscriptions")
    .update({
      cancel_at_period_end: scheduled,
      ...(scheduled ? {} : { status: "canceled", canceled_at: new Date().toISOString() }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", current.id);

  if (error) {
    throw error;
  }

  const updated = await getCandidateSubscription(client, candidateId);

  return {
    kind: "canceled",
    subscription: updated ?? { ...current, cancelAtPeriodEnd: scheduled },
  };
}

export interface ProviderSubscriptionUpdate {
  providerSubscriptionId: string;
  status: "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "canceled";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export type ApplyUpdateResult = { kind: "updated" } | { kind: "not_found" };

/**
 * Applies a Stripe subscription lifecycle event to the row the checkout created.
 *
 * Matched by provider_subscription_id, which is unique per provider — so an
 * event for a subscription this system never recorded is reported as
 * not_found rather than creating a row. A webhook must not be able to conjure
 * a subscription for a candidate nobody ever checked out.
 */
export async function applyProviderSubscriptionUpdate(
  client: SupabaseClient,
  update: ProviderSubscriptionUpdate,
): Promise<ApplyUpdateResult> {
  const { data: existing, error: findError } = await client
    .from("subscriptions")
    .select("id")
    .eq("provider_subscription_id", update.providerSubscriptionId)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (!existing) {
    return { kind: "not_found" };
  }

  const { error } = await client
    .from("subscriptions")
    .update({
      status: update.status,
      current_period_start: update.currentPeriodStart,
      current_period_end: update.currentPeriodEnd,
      cancel_at_period_end: update.cancelAtPeriodEnd,
      ...(update.status === "canceled" ? { canceled_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", (existing as { id: string }).id);

  if (error) {
    throw error;
  }

  return { kind: "updated" };
}

export interface CheckoutCompletedInput {
  candidateId: string;
  planCode: string;
  provider: "stripe" | "razorpay" | "manual";
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  region: string;
  currency: string;
  billingInterval: BillingInterval;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export type ApplyCheckoutResult =
  | { kind: "applied"; subscriptionId: string }
  | { kind: "unknown_plan"; planCode: string };

/**
 * Records a completed checkout.
 *
 * The plan is looked up by CODE rather than trusted as an id from the event, so
 * a webhook carrying a stale or hostile plan identifier can only ever resolve to
 * a plan that exists. An unknown code is reported, not invented.
 */
export async function applyCheckoutCompleted(
  client: SupabaseClient,
  input: CheckoutCompletedInput,
): Promise<ApplyCheckoutResult> {
  const { data: plan, error: planError } = await client
    .from("subscription_plans")
    .select("id")
    .eq("code", input.planCode)
    .maybeSingle();

  if (planError) {
    throw planError;
  }

  if (!plan) {
    return { kind: "unknown_plan", planCode: input.planCode };
  }

  const planId = (plan as { id: string }).id;
  const now = new Date().toISOString();

  const { data: existing, error: existingError } = await client
    .from("subscriptions")
    .select("id")
    .eq("candidate_id", input.candidateId)
    .in("status", [...LIVE_SUBSCRIPTION_STATUSES])
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  const payload = {
    candidate_id: input.candidateId,
    plan_id: planId,
    provider: input.provider,
    provider_customer_id: input.providerCustomerId,
    provider_subscription_id: input.providerSubscriptionId,
    status: "active",
    region: input.region,
    currency: input.currency,
    billing_interval: input.billingInterval,
    current_period_start: input.currentPeriodStart,
    current_period_end: input.currentPeriodEnd,
    updated_at: now,
  };

  if (existing) {
    const { error } = await client.from("subscriptions").update(payload).eq("id", (existing as { id: string }).id);
    if (error) {
      throw error;
    }
    return { kind: "applied", subscriptionId: (existing as { id: string }).id };
  }

  const { data: inserted, error: insertError } = await client
    .from("subscriptions")
    .insert(payload)
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw insertError ?? new Error("Subscription insert returned no row.");
  }

  return { kind: "applied", subscriptionId: (inserted as { id: string }).id };
}
