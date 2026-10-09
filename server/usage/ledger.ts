import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingInterval } from "../billing/plans.js";

/**
 * Phase 2c M6/M7 - the only writer of candidate_usage_events.
 *
 * The table is service-role-only and has no candidate write path, so every number
 * in it is written here, from the server, through one module. That is deliberate: a
 * ledger whose inserts are scattered across routes is one whose uniqueness keys
 * nobody can audit.
 *
 * NOTHING IN HERE EVER UPDATES OR DELETES. A refund is a compensating GRANT, not a
 * reversal of the spend, so the history keeps showing what was actually consumed
 * and then returned.
 */

export const DISCOVERY_RUN_KIND = "discovery_run";
export const AI_CREDIT_GRANT_KIND = "ai_credit_grant";
export const AI_CREDIT_SPEND_KIND = "ai_credit_spend";

const LIVE_STATUSES = ["incomplete", "trialing", "active", "past_due", "unpaid"] as const;

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface DiscoverySurfaceResult {
  /** Vacancies newly recorded for this candidate today. */
  recorded: number;
  /** Already recorded earlier today - a re-read, a re-sort, a filter change. */
  duplicates: number;
}

/**
 * Record that these vacancies were first surfaced for this candidate today.
 *
 * DISTINCTNESS IS A CONSTRAINT, NOT A QUERY. One row per (candidate, vacancy,
 * calendar day), keyed through idempotency_key, so re-reading the feed, paginating,
 * re-sorting or changing filters re-inserts the same keys and writes nothing. That
 * is what makes "50 a day" mean fifty JOBS rather than fifty page views.
 *
 * The RAW count is returned rather than capped at the allowance. Capping on write
 * would make the ledger record a number that did not happen and destroy the
 * over-consumption audit trail; the gate refuses on READ instead.
 */
export async function recordDiscoverySurfaces(
  client: SupabaseClient,
  candidateId: string,
  vacancyIds: string[],
  at: Date = new Date(),
): Promise<DiscoverySurfaceResult> {
  const unique = [...new Set(vacancyIds.filter((id) => typeof id === "string" && id.length > 0))];

  if (unique.length === 0) {
    return { recorded: 0, duplicates: 0 };
  }

  const key = dayKey(at);

  const { data, error } = await client
    .from("candidate_usage_events")
    .upsert(
      unique.map((vacancyId) => ({
        candidate_id: candidateId,
        kind: DISCOVERY_RUN_KIND,
        quantity: 1,
        idempotency_key: vacancyId + ":" + key,
      })),
      // ignoreDuplicates -> ON CONFLICT DO NOTHING, so RETURNING yields ONLY the
      // rows actually inserted, and the difference is the duplicate count.
      { onConflict: "candidate_id,kind,idempotency_key", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    throw error;
  }

  const recorded = Array.isArray(data) ? data.length : 0;

  return { recorded, duplicates: unique.length - recorded };
}

/**
 * Distinct vacancies first surfaced for this candidate since the start of the
 * CALENDAR DAY - not the billing period. Discovery resets daily, and using the
 * subscription period here would quietly turn "50 a day" into "50 a month".
 */
export async function loadDiscoveryConsumption(
  client: SupabaseClient,
  candidateId: string,
  at: Date = new Date(),
): Promise<number> {
  const start = new Date(at);
  start.setUTCHours(0, 0, 0, 0);

  const { count, error } = await client
    .from("candidate_usage_events")
    .select("id", { count: "exact", head: true })
    .eq("candidate_id", candidateId)
    .eq("kind", DISCOVERY_RUN_KIND)
    .gte("occurred_at", start.toISOString());

  if (error) {
    throw error;
  }

  return count ?? 0;
}

/**
 * Credits available: grants minus spends. A signed sum over the ledger, never a
 * stored balance, so it cannot drift from the rows it claims to summarise.
 */
export async function loadAiCreditBalance(
  client: SupabaseClient,
  candidateId: string,
): Promise<number> {
  const { data, error } = await client
    .from("candidate_usage_events")
    .select("quantity")
    .eq("candidate_id", candidateId)
    .in("kind", [AI_CREDIT_GRANT_KIND, AI_CREDIT_SPEND_KIND]);

  if (error) {
    throw error;
  }

  return (data ?? []).reduce((total, row) => total + Number((row as { quantity: number }).quantity), 0);
}

export type ReserveCreditResult =
  | { kind: "reserved"; balanceAfter: number }
  | { kind: "insufficient"; balance: number }
  | { kind: "already_reserved" };

/**
 * Reserve one credit BEFORE the model call.
 *
 * BEFORE, not after: a spend written only on success leaves a failed or timed-out
 * generation with no evidence that the model ever ran, and the candidate keeps a
 * credit for work the provider may well have billed for. The caller releases it on
 * failure by writing a compensating grant.
 *
 * A duplicate idempotency_key means this exact run was already charged, so it
 * reports already_reserved and does NOT charge again - a retried request must not
 * cost a second credit.
 */
export async function reserveAiCredit(
  client: SupabaseClient,
  candidateId: string,
  idempotencyKey: string,
): Promise<ReserveCreditResult> {
  // ALREADY-RESERVED IS CHECKED FIRST, and the order matters: checking the balance
  // first would refuse a legitimate RETRY of a run that was already charged, the
  // moment that run used the last credit.
  const { data: existing, error: existingError } = await client
    .from("candidate_usage_events")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("kind", AI_CREDIT_SPEND_KIND)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existing) {
    return { kind: "already_reserved" };
  }

  const balance = await loadAiCreditBalance(client, candidateId);

  if (balance < 1) {
    return { kind: "insufficient", balance };
  }

  const { data, error } = await client
    .from("candidate_usage_events")
    .insert({
      candidate_id: candidateId,
      kind: AI_CREDIT_SPEND_KIND,
      quantity: -1,
      idempotency_key: idempotencyKey,
    })
    .select("id");

  if (error) {
    // 23505 -> the unique key fired, i.e. this run was already charged.
    if ((error as { code?: string }).code === "23505") {
      return { kind: "already_reserved" };
    }
    throw error;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { kind: "already_reserved" };
  }

  return { kind: "reserved", balanceAfter: balance - 1 };
}

/**
 * Give back a reserved credit after a failed generation. A GRANT, never a delete:
 * the spend stays in the ledger so the failed run is still visible and the pair
 * reconciles. Keyed on the spend key, so a retried release cannot hand back two.
 */
export async function releaseAiCredit(
  client: SupabaseClient,
  candidateId: string,
  spendKey: string,
  reason: string,
): Promise<void> {
  const { error } = await client.from("candidate_usage_events").upsert(
    {
      candidate_id: candidateId,
      kind: AI_CREDIT_GRANT_KIND,
      quantity: 1,
      idempotency_key: spendKey + ":refund",
      metadata: { reason },
    },
    { onConflict: "candidate_id,kind,idempotency_key", ignoreDuplicates: true },
  );

  if (error) {
    throw error;
  }
}

/**
 * The candidate's effective plan: the live subscription's, else Free. Shared by the
 * credit grant and the discovery limit so the two cannot disagree about which plan
 * somebody is on.
 *
 * A SUBSCRIPTION'S OWN plan_id IS USED EVEN IF THE PLAN ROW IS MISSING - the
 * catalogue might have been renamed under it. Only the absence of any subscription
 * falls back to Free, which is what "no subscription IS the Free plan" means here.
 */
async function resolvePlanId(client: SupabaseClient, candidateId: string): Promise<string | null> {
  const { data: subscription, error: subscriptionError } = await client
    .from("subscriptions")
    .select("plan_id")
    .eq("candidate_id", candidateId)
    .in("status", [...LIVE_STATUSES])
    .maybeSingle();

  if (subscriptionError) {
    throw subscriptionError;
  }

  const subscribed = (subscription as { plan_id?: string } | null)?.plan_id ?? null;

  if (subscribed) {
    return subscribed;
  }

  const { data: freePlan, error: freeError } = await client
    .from("subscription_plans")
    .select("id")
    .eq("code", "free")
    .maybeSingle();

  if (freeError) {
    throw freeError;
  }

  return (freePlan as { id: string } | null)?.id ?? null;
}

/**
 * The daily discovery allowance, or NULL when the plan's row or the column is
 * missing.
 *
 * NULL IS NOT ZERO. Zero means "this plan includes no discovery"; null means "we
 * could not tell". The caller must not treat the second as the first, or a
 * configuration gap switches discovery off for everybody.
 */
export async function loadDailyDiscoveryLimit(
  client: SupabaseClient,
  candidateId: string,
): Promise<number | null> {
  const planId = await resolvePlanId(client, candidateId);

  if (!planId) {
    return null;
  }

  const { data, error } = await client
    .from("plan_limits")
    .select("max_daily_discovery_jobs")
    .eq("plan_id", planId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const value = (data as { max_daily_discovery_jobs: number | null } | null)
    ?.max_daily_discovery_jobs;

  return typeof value === "number" ? value : null;
}

export interface PeriodGrantResult {
  granted: number;
  billingInterval: BillingInterval;
  periodStartsAt: string;
}

/**
 * Lazily write this period's credit grant, if it has not been written already.
 *
 * LAZY RATHER THAN SCHEDULED, and that is the whole reason M7 needs no rollover
 * job: the grant is keyed on the period start, so the first generation of a new
 * period writes it once and every later call is a no-op. A scheduled rollover would
 * have to be retried, missed-deploy-safe and timezone-correct; a keyed insert
 * already is all three.
 *
 * Returns granted 0 when the plan has no allowance - Free included - so the caller
 * can tell "this plan includes no credits" from "credits, all spent".
 */
export async function ensurePeriodCreditGrant(
  client: SupabaseClient,
  candidateId: string,
  at: Date = new Date(),
): Promise<PeriodGrantResult> {
  const { data: periodRows, error: periodError } = await client.rpc("candidate_billing_period", {
    p_candidate_id: candidateId,
    p_at: at.toISOString(),
  });

  if (periodError) {
    throw periodError;
  }

  const period = (Array.isArray(periodRows) ? periodRows[0] : periodRows) as
    | { starts_at: string; billing_interval: BillingInterval }
    | undefined;

  if (!period) {
    throw new Error("candidate_billing_period returned no row");
  }

  const empty = {
    granted: 0,
    billingInterval: period.billing_interval,
    periodStartsAt: period.starts_at,
  };

  const planId = await resolvePlanId(client, candidateId);

  if (!planId) {
    return empty;
  }

  const { data: limits, error: limitsError } = await client
    .from("plan_limits")
    .select("max_ai_credits_per_month, max_ai_credits_per_week")
    .eq("plan_id", planId)
    .maybeSingle();

  if (limitsError) {
    throw limitsError;
  }

  const row = (limits ?? null) as {
    max_ai_credits_per_month: number | null;
    max_ai_credits_per_week: number | null;
  } | null;

  const allowance =
    (period.billing_interval === "week"
      ? row?.max_ai_credits_per_week
      : row?.max_ai_credits_per_month) ?? 0;

  if (allowance <= 0) {
    return empty;
  }

  const { error: grantError } = await client.from("candidate_usage_events").upsert(
    {
      candidate_id: candidateId,
      kind: AI_CREDIT_GRANT_KIND,
      quantity: allowance,
      idempotency_key: period.starts_at + ":grant",
      metadata: { billingInterval: period.billing_interval, allowance },
    },
    { onConflict: "candidate_id,kind,idempotency_key", ignoreDuplicates: true },
  );

  if (grantError) {
    throw grantError;
  }

  return { granted: allowance, billingInterval: period.billing_interval, periodStartsAt: period.starts_at };
}
