import { describe, expect, it } from "vitest";
import { evaluateEntitlements } from "./entitlements.js";
import { loadAutomationEntitlement } from "./automationEntitlement.js";

function chain(value: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    builder[method] = () => builder;
  }
  builder.single = async () => value;
  builder.maybeSingle = async () => value;
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  return builder;
}

/**
 * `consumed` is what candidate_entitlement_usage reports for the period. Zero for
 * every case that only cares about the allowance itself.
 */
function fakeClient(tables: Record<string, { data: unknown; error: unknown }>, consumed = 0) {
  return {
    from: (table: string) => chain(tables[table] ?? { data: null, error: null }),
    rpc: async () => ({ data: [{ consumed_applications_this_period: consumed }], error: null }),
  } as never;
}

const FREE_PLAN = { data: { id: "plan-free", code: "free" }, error: null };
const FREE_LIMITS = {
  data: { max_auto_apply_india_per_month: 0, max_auto_apply_us_per_month: 0 },
  error: null,
};
const PRO_PLAN = { data: { id: "plan-pro", code: "pro" }, error: null };
const PRO_LIMITS = {
  data: { max_auto_apply_india_per_month: 100, max_auto_apply_us_per_month: 300 },
  error: null,
};

describe("loadAutomationEntitlement", () => {
  it("resolves a candidate with no subscription to the Free plan, which has no allowance", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient({ subscription_plans: FREE_PLAN, plan_limits: FREE_LIMITS }),
      "cand-1",
    );

    expect(result).toEqual({
      planEntitled: false,
      planCode: "free",
      limit: 0,
      consumed: 0,
      quotaExhausted: false,
      billingInterval: "month",
    });
  });

  it("is entitled for a live subscription whose plan has a non-zero allowance", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient({
        subscriptions: { data: { plan_id: "plan-pro" }, error: null },
        subscription_plans: PRO_PLAN,
        plan_limits: PRO_LIMITS,
      }),
      "cand-1",
    );

    expect(result).toEqual({
      planEntitled: true,
      planCode: "pro",
      // max(india, us) — 300, not 400.
      limit: 300,
      consumed: 0,
      quotaExhausted: false,
      billingInterval: "month",
    });
  });

  it("is entitled when only ONE destination quota is non-zero", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient({
        subscriptions: { data: { plan_id: "plan-starter" }, error: null },
        subscription_plans: { data: { id: "plan-starter", code: "starter" }, error: null },
        plan_limits: {
          data: { max_auto_apply_india_per_month: 0, max_auto_apply_us_per_month: 80 },
          error: null,
        },
      }),
      "cand-1",
    );

    expect(result.planEntitled).toBe(true);
  });

  it("reports an entitled plan as exhausted once the period's allowance is spent", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient(
        {
          subscriptions: { data: { plan_id: "plan-pro" }, error: null },
          subscription_plans: PRO_PLAN,
          plan_limits: PRO_LIMITS,
        },
        300,
      ),
      "cand-1",
    );

    // STILL ENTITLED — the plan does include automation. Exhaustion is a separate
    // fact, so the gate can say "you have used this period" rather than "buy a
    // plan" to somebody who already has one.
    expect(result.planEntitled).toBe(true);
    expect(result.quotaExhausted).toBe(true);
    expect(result.consumed).toBe(300);
    expect(result.limit).toBe(300);
  });

  it("reads the WEEKLY columns when the subscription was bought weekly", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient({
        subscriptions: { data: { plan_id: "plan-starter", billing_interval: "week" }, error: null },
        subscription_plans: { data: { id: "plan-starter", code: "starter" }, error: null },
        plan_limits: {
          data: {
            max_auto_apply_india_per_month: 100,
            max_auto_apply_us_per_month: 100,
            max_auto_apply_india_per_week: 25,
            max_auto_apply_us_per_week: 25,
          },
          error: null,
        },
      }),
      "cand-1",
    );

    // 25, not 100: comparing a weekly plan against the monthly column would hand
    // it four times what it paid for.
    expect(result.billingInterval).toBe("week");
    expect(result.limit).toBe(25);
  });

  it("is NOT entitled when the effective plan has no plan_limits row", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient({
        subscriptions: { data: { plan_id: "plan-pro" }, error: null },
        subscription_plans: PRO_PLAN,
        plan_limits: { data: null, error: null },
      }),
      "cand-1",
    );

    expect(result).toEqual({
      planEntitled: false,
      planCode: "pro",
      limit: 0,
      consumed: 0,
      quotaExhausted: false,
      billingInterval: "month",
    });
  });

  it("throws on a query error rather than reporting a plan problem", async () => {
    await expect(
      loadAutomationEntitlement(
        fakeClient({ subscriptions: { data: null, error: { message: "down" } } }),
        "cand-1",
      ),
    ).rejects.toBeTruthy();
  });

  /**
   * REGRESSION: the dedicated loader must not have changed the Billing summary's
   * documented rule. A no-subscription candidate is still permissive there (every
   * dimension unconfigured = allowed), which is what the other ten dimensions and
   * the Billing UI rely on.
   */
  it("leaves evaluateEntitlements permissive for a no-subscription candidate", async () => {
    const summary = await evaluateEntitlements(fakeClient({}), "cand-1");

    expect(summary.hasLiveSubscription).toBe(false);
    expect(summary.evaluations.every((entry) => entry.configured === false && entry.allowed === true)).toBe(true);
  });
});
