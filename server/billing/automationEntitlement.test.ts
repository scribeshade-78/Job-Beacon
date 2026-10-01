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

function fakeClient(tables: Record<string, { data: unknown; error: unknown }>) {
  return {
    from: (table: string) => chain(tables[table] ?? { data: null, error: null }),
    rpc: async () => ({ data: [], error: null }),
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

    expect(result).toEqual({ planEntitled: false, planCode: "free" });
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

    expect(result).toEqual({ planEntitled: true, planCode: "pro" });
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

  it("is NOT entitled when the effective plan has no plan_limits row", async () => {
    const result = await loadAutomationEntitlement(
      fakeClient({
        subscriptions: { data: { plan_id: "plan-pro" }, error: null },
        subscription_plans: PRO_PLAN,
        plan_limits: { data: null, error: null },
      }),
      "cand-1",
    );

    expect(result).toEqual({ planEntitled: false, planCode: "pro" });
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
