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
  it("reports a configured allowance with NO measured usage, rather than a fabricated zero", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_auto_apply_india_per_month: 100, max_auto_apply_us_per_month: 300 },
      }),
      "cand-1",
    );

    const india = find(summary, "auto_apply_india_per_month");
    expect(india.configured).toBe(true);
    expect(india.limit).toBe(100);
    // Nothing counts applications per destination yet, so a usage of 0 would be
    // an invented number. usage and remaining stay null, and allowed answers only
    // whether the plan includes the allowance at all.
    expect(india.usage).toBeNull();
    expect(india.remaining).toBeNull();
    expect(india.allowed).toBe(true);
    expect(find(summary, "auto_apply_us_per_month").limit).toBe(300);
  });

  it("withholds the allowance when the plan grants none, which is the Free plan", async () => {
    const summary = await evaluateEntitlements(
      fakeClient({
        subscription: LIVE_SUBSCRIPTION,
        plan: PLAN,
        limits: { ...allNullLimits(), max_auto_apply_india_per_month: 0, max_auto_apply_us_per_month: 0 },
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
