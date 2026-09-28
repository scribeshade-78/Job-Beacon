import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The subscription module is mocked: these tests are about WHAT the early-access
 * switch asks it to write — the provider, the periods, the region — not about
 * the insert itself, which subscription.ts's own suite covers.
 */
vi.mock("./subscription.js", () => ({
  applyCheckoutCompleted: vi.fn(),
  cancelCandidateSubscription: vi.fn(),
}));

import { applyCheckoutCompleted, cancelCandidateSubscription } from "./subscription.js";
import { selectCandidatePlan } from "./selectPlan.js";

const applyMock = vi.mocked(applyCheckoutCompleted);
const cancelMock = vi.mocked(cancelCandidateSubscription);

const CLIENT = {} as never;

afterEach(() => {
  vi.clearAllMocks();
});

describe("selectCandidatePlan", () => {
  it("closes the live row when the candidate chooses Free", async () => {
    cancelMock.mockResolvedValue({ kind: "no_subscription" });

    const result = await selectCandidatePlan(CLIENT, {
      candidateId: "user-123",
      planCode: "free",
      region: "IN",
      currency: "INR",
    });

    expect(result).toEqual({ kind: "downgraded" });
    expect(cancelMock).toHaveBeenCalledWith(CLIENT, "user-123");
    expect(applyMock).not.toHaveBeenCalled();
  });

  /**
   * "no_subscription" is not a failure here: the candidate asked to be on Free
   * and they are on Free either way.
   */
  it("treats an already-Free candidate as a successful downgrade", async () => {
    cancelMock.mockResolvedValue({ kind: "no_subscription" });

    const result = await selectCandidatePlan(CLIENT, {
      candidateId: "user-123",
      planCode: "free",
      region: "US",
      currency: "USD",
    });

    expect(result.kind).toBe("downgraded");
  });

  it("activates a paid plan as a manual grant with no periods", async () => {
    applyMock.mockResolvedValue({ kind: "applied", subscriptionId: "sub-1" });

    const result = await selectCandidatePlan(CLIENT, {
      candidateId: "user-123",
      planCode: "pro",
      region: "IN",
      currency: "INR",
    });

    expect(result).toEqual({ kind: "activated", planCode: "pro", subscriptionId: "sub-1" });

    expect(applyMock).toHaveBeenCalledWith(CLIENT, {
      candidateId: "user-123",
      planCode: "pro",
      provider: "manual",
      providerCustomerId: null,
      providerSubscriptionId: null,
      region: "IN",
      currency: "INR",
      billingInterval: "month",
      // NO PERIOD is the point: a grant with no period end is one that
      // cancelCandidateSubscription closes immediately, which is honest for
      // something nobody paid for.
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
  });

  it("passes the region and currency through for a non-India candidate", async () => {
    applyMock.mockResolvedValue({ kind: "applied", subscriptionId: "sub-2" });

    await selectCandidatePlan(CLIENT, {
      candidateId: "user-9",
      planCode: "power",
      region: "EU",
      currency: "EUR",
    });

    expect(applyMock).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ region: "EU", currency: "EUR", provider: "manual" }),
    );
  });

  it("reports an unknown plan rather than inventing one", async () => {
    applyMock.mockResolvedValue({ kind: "unknown_plan", planCode: "enterprise" });

    const result = await selectCandidatePlan(CLIENT, {
      candidateId: "user-123",
      planCode: "enterprise",
      region: "IN",
      currency: "INR",
    });

    expect(result).toEqual({ kind: "unknown_plan", planCode: "enterprise" });
  });

  it("reports a failure rather than throwing", async () => {
    applyMock.mockRejectedValue(new Error("PostgREST unreachable"));

    const result = await selectCandidatePlan(CLIENT, {
      candidateId: "user-123",
      planCode: "starter",
      region: "IN",
      currency: "INR",
    });

    expect(result.kind).toBe("failed");
  });

  it("reports a cancellation failure rather than throwing", async () => {
    cancelMock.mockRejectedValue(new Error("PostgREST unreachable"));

    const result = await selectCandidatePlan(CLIENT, {
      candidateId: "user-123",
      planCode: "free",
      region: "IN",
      currency: "INR",
    });

    expect(result).toEqual({ kind: "failed", message: "PostgREST unreachable" });
  });
});
