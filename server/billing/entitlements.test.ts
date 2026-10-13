import { describe, expect, it } from "vitest";
import { ENTITLEMENT_DIMENSIONS, evaluateEntitlements } from "./entitlements.js";

/**
 * The rules under test are the ones PRD v3 §27.3 creates: an unconfigured
 * dimension is PERMISSIVE (nothing is promised, so nothing is withheld), the
 * word "unlimited" must never be reachable through this type, and usage is
 * counted even when no limit is set so a founder can see consumption before
 * deciding what the limit should be.
 */

const USAGE = {
  active_target_roles: 4,
  verified_applications_this_period: 3,
  consumed_applications_this_period: 5,
  ats_resume_variants: 6,
  connected_mailboxes: 1,
  // DELIBERATELY SUMS TO LESS THAN consumed_applications_this_period (2 + 1 = 3 of 5),
  // because that is the real shape: attempts against a NULL-country vacancy belong to
  // neither destination. A fixture where the split summed exactly would let a rounding or
  // double-count bug pass.
  consumed_applications_india_this_period: 2,
  consumed_applications_us_this_period: 1,
};

interface FakeOptions {
  subscription?: Record<string, unknown> | null;
  plan?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
  usage?: Record<string, unknown> | null;
}

/** A thenable, chainable stand-in for a PostgREST builder. */
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

function fakeClient(options: FakeOptions) {
  const usage = options.usage === undefined ? USAGE : options.usage;
  return {
    from: (table: string) => {
      if (table === "subscriptions") {
        return chain({ data: options.subscription ?? null, error: null });
      }
      if (table === "subscription_plans") {
        return chain({ data: options.plan ?? null, error: null });
      }
      if (table === "plan_limits") {
        return chain({ data: options.limits ?? null, error: null });
      }
      return chain({ data: null, error: null });
    },
    rpc: async () => ({ data: usage === null ? [] : [usage], error: null }),
  } as never;
}

const LIVE_SUBSCRIPTION = {
  id: "sub-1",
  plan_id: "plan-1",
  provider: "stripe",
  status: "active",
  region: "IN",
  currency: "INR",
  billing_interval: "month",
  current_period_start: null,
  current_period_end: null,
  cancel_at_period_end: false,
};

const PLAN = { id: "plan-1", code: "pro", display_name: "Pro" };

function allNullLimits(): Record<string, unknown> {
  return {
    plan_id: "plan-1",
    max_active_target_roles: null,
    max_verified_applications_per_month: null,
    max_auto_apply_india_per_month: null,
    max_auto_apply_us_per_month: null,
    premium_source_access: null,
    max_ats_resume_variants: null,
    max_mailbox_connections: null,
    company_intelligence_depth: null,
    priority_action_required_support: null,
    analytics_history_days: null,
    data_exports_enabled: null,
  };
}

function find(summary: Awaited<ReturnType<typeof evaluateEntitlements>>, dimension: string) {
  const evaluation = summary.evaluations.find((entry) => entry.dimension === dimension);
  if (!evaluation) {
    throw new Error("dimension not evaluated: " + dimension);
  }
  return evaluation;
}

describe("ENTITLEMENT_DIMENSIONS", () => {
  it("covers the eight §27.2 bullets, with the compound one split, plus the two destination quotas", () => {
    // 9 + 2. The eight §27.2 bullets occupy nine entries because the eighth is
    // compound and split; the destination auto-apply allowance adds two more,
    // since the product states it once for India and once for the US.
    expect(ENTITLEMENT_DIMENSIONS).toHaveLength(11);
    const labels = new Set(ENTITLEMENT_DIMENSIONS.map((spec) => spec.prdLabel));
    expect(labels.size).toBe(10);
    const shared = ENTITLEMENT_DIMENSIONS.filter((spec) => spec.prdLabel === "Historical analytics and exports");
    expect(shared.map((spec) => spec.id)).toEqual(["analytics_history_days", "data_exports_enabled"]);
    const destinations = ENTITLEMENT_DIMENSIONS.filter((spec) => spec.id.startsWith("auto_apply"));
    expect(destinations.map((spec) => spec.id)).toEqual(["auto_apply_india_per_month", "auto_apply_us_per_month"]);
  });
});

describe("evaluateEntitlements with no subscription", () => {
  it("treats every dimension as permissive, because nothing was promised", async () => {
    const summary = await evaluateEntitlements(fakeClient({ subscription: null }), "cand-1");

    expect(summary.hasLiveSubscription).toBe(false);
    expect(summary.planCode).toBeNull();
    expect(summary.allUnconfigured).toBe(true);
    expect(summary.evaluations).toHaveLength(11);
    expect(summary.evaluations.every((entry) => entry.configured === false && entry.allowed === true)).toBe(true);
  });

  it("still counts usage, so limits can be set from observed consumption", async () => {
    const summary = await evaluateEntitlements(fakeClient({ subscription: null }), "cand-1");
    expect(find(summary, "active_target_roles").usage).toBe(4);
    expect(find(summary, "verified_applications_per_month").usage).toBe(3);
    expect(find(summary, "ats_resume_variants").usage).toBe(6);
    expect(find(summary, "mailbox_connections").usage).toBe(1);
  });

  it("survives an empty usage result without inventing a number", async () => {
    const summary = await evaluateEntitlements(fakeClient({ subscription: null, usage: null }), "cand-1");
    expect(find(summary, "active_target_roles").usage).toBe(0);
  });
});

describe("evaluateEntitlements with an all-NULL plan", () => {
  it("is still unconfigured, which is the shipped state of every plan in H1", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({ subscription: LIVE_SUBSCRIPTION, plan: PLAN, limits: allNullLimits() }),
      "cand-1",
    );

    expect(summary.hasLiveSubscription).toBe(true);
    expect(summary.planCode).toBe("pro");
    expect(summary.allUnconfigured).toBe(true);
    expect(summary.evaluations.every((entry) => entry.allowed)).toBe(true);
  });
});

describe("destination auto-apply quotas", () => {
  it("reports the WEEKLY allowance against the destination's MEASURED usage", async () => {
    // This test asserted the opposite until the destination split existed: usage and
    // remaining were null because candidate_entitlement_usage counted applications
    // globally with no destination. It does now (20261014000000), so null would be the
    // wrong answer in the other direction - withholding a number we do have.
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        // THE WEEKLY COLUMNS. These are what M7 enforces, and what the dimension reads.
        limits: { ...allNullLimits(), max_auto_apply_india_per_week: 100, max_auto_apply_us_per_week: 300 },
      }),
      "cand-1",
    );

    const india = find(summary, "auto_apply_india_per_month");
    expect(india.configured).toBe(true);
    expect(india.limit).toBe(100);
    expect(india.usage).toBe(2);
    expect(india.remaining).toBe(98);
    expect(india.allowed).toBe(true);
    // The label must describe the window the number comes from, or a candidate is shown
    // a weekly cap while believing it is monthly - the invisible wall.
    expect(india.prdLabel).toMatch(/per week/i);

    const us = find(summary, "auto_apply_us_per_month");
    expect(us.limit).toBe(300);
    expect(us.usage).toBe(1);
    expect(us.remaining).toBe(299);
  });

  it("withholds the allowance when the plan grants none, which is the Free plan", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_auto_apply_india_per_week: 0, max_auto_apply_us_per_week: 0 },
      }),
      "cand-1",
    );

    expect(find(summary, "auto_apply_india_per_month").allowed).toBe(false);
    expect(find(summary, "auto_apply_us_per_month").allowed).toBe(false);
  });
});

describe("countable dimensions", () => {
  it("allows usage below the limit and reports what is left", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_active_target_roles: 10 },
      }),
      "cand-1",
    );

    const evaluation = find(summary, "active_target_roles");
    expect(evaluation.configured).toBe(true);
    expect(evaluation.allowed).toBe(true);
    expect(evaluation.limit).toBe(10);
    expect(evaluation.usage).toBe(4);
    expect(evaluation.remaining).toBe(6);
  });

  it("refuses once usage reaches the limit, and never reports negative remaining", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_active_target_roles: 4 },
      }),
      "cand-1",
    );

    const evaluation = find(summary, "active_target_roles");
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.remaining).toBe(0);
  });

  it("refuses when usage has already exceeded the limit", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_mailbox_connections: 1 },
      }),
      "cand-1",
    );

    const evaluation = find(summary, "mailbox_connections");
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.usage).toBe(1);
    expect(evaluation.remaining).toBe(0);
  });

  it("honours a zero limit as a real prohibition, not as unconfigured", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_ats_resume_variants: 0 },
      }),
      "cand-1",
    );

    const evaluation = find(summary, "ats_resume_variants");
    expect(evaluation.configured).toBe(true);
    expect(evaluation.allowed).toBe(false);
  });
});

describe("capability and depth dimensions", () => {
  it("withholds a capability set to false and grants it when true", async () => {
    const denied = await evaluateEntitlements(
      fakeClient({ subscription: LIVE_SUBSCRIPTION, plan: PLAN, limits: { ...allNullLimits(), premium_source_access: false } }),
      "cand-1",
    );
    expect(find(denied, "premium_source_access")).toMatchObject({ configured: true, allowed: false, limit: false });

    const granted = await evaluateEntitlements(
      fakeClient({ subscription: LIVE_SUBSCRIPTION, plan: PLAN, limits: { ...allNullLimits(), data_exports_enabled: true } }),
      "cand-1",
    );
    expect(find(granted, "data_exports_enabled")).toMatchObject({ configured: true, allowed: true, limit: true });
  });

  it("treats company intelligence depth as an ordinal rather than a flag", async () => {
    const none = await evaluateEntitlements(
      fakeClient({ subscription: LIVE_SUBSCRIPTION, plan: PLAN, limits: { ...allNullLimits(), company_intelligence_depth: "none" } }),
      "cand-1",
    );
    expect(find(none, "company_intelligence_depth")).toMatchObject({ allowed: false, limit: "none" });

    const full = await evaluateEntitlements(
      fakeClient({ subscription: LIVE_SUBSCRIPTION, plan: PLAN, limits: { ...allNullLimits(), company_intelligence_depth: "full" } }),
      "cand-1",
    );
    expect(find(full, "company_intelligence_depth")).toMatchObject({ allowed: true, limit: "full" });
  });
});

describe("the unconfigured state", () => {
  it("is never reported as a number, so the UI cannot render it as unlimited", async () => {
    const summary = await evaluateEntitlements(fakeClient({ subscription: null }), "cand-1");

    for (const evaluation of summary.evaluations) {
      expect(evaluation.configured).toBe(false);
      expect(evaluation.limit).toBeNull();
      expect(evaluation.remaining).toBeNull();
    }
  });

  it("clears allUnconfigured as soon as one dimension is set", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({ subscription: LIVE_SUBSCRIPTION, plan: PLAN, limits: { ...allNullLimits(), data_exports_enabled: true } }),
      "cand-1",
    );
    expect(summary.allUnconfigured).toBe(false);
  });
});
