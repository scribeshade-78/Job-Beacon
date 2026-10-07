import { describe, expect, it, vi } from "vitest";
import { describeBulkApplyResult, findActionableBlocker, submitBulkApply, type BulkApplyResult } from "./bulkApply";

function result(overrides: Partial<BulkApplyResult> = {}): BulkApplyResult {
  return { requested: 0, queued: 0, blocked: 0, errors: 0, outcomes: [], ...overrides };
}

function blockedBy(reasonCode: string | null, gate = "application_support") {
  return { vacancyId: "v1", status: "blocked" as const, blockingGates: [{ gate, reasonCode }] };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const token = async () => "token-123";

describe("submitBulkApply", () => {
  it("posts the vacancy ids with the caller's bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, result({ requested: 2, queued: 2 })));

    const outcome = await submitBulkApply(["v1", "v2"], { fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(fetchImpl).toHaveBeenCalledWith("/api/opportunities/bulk-apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-123" },
      body: JSON.stringify({ vacancyIds: ["v1", "v2"] }),
    });
    expect(outcome.kind).toBe("success");
  });

  it("does not call the endpoint without a session", async () => {
    const fetchImpl = vi.fn();

    const outcome = await submitBulkApply(["v1"], { fetchImpl: fetchImpl as never, getAccessToken: async () => null });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("error");
  });

  it("maps 401 and 429 to specific messages", async () => {
    const unauthorized = await submitBulkApply(["v1"], {
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(401, {})) as never,
      getAccessToken: token,
    });
    expect(unauthorized).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });

    const limited = await submitBulkApply(["v1"], {
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(429, {})) as never,
      getAccessToken: token,
    });
    expect(limited.kind).toBe("error");
    if (limited.kind === "error") expect(limited.message).toMatch(/too quickly/i);
  });

  it("returns an error result instead of throwing when the network fails", async () => {
    const outcome = await submitBulkApply(["v1"], {
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) as never,
      getAccessToken: token,
    });

    expect(outcome).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("describeBulkApplyResult", () => {
  it("reports a full success", () => {
    expect(describeBulkApplyResult(result({ requested: 5, queued: 5 }))).toEqual({
      text: "Successfully queued 5 applications.",
      tone: "success",
    });
  });

  it("uses the singular for one application", () => {
    expect(describeBulkApplyResult(result({ requested: 1, queued: 1 })).text).toBe(
      "Successfully queued 1 application.",
    );
  });

  it("reports partial success with the blocked count, as a success tone", () => {
    expect(describeBulkApplyResult(result({ requested: 15, queued: 5, blocked: 10 }))).toEqual({
      text: "Successfully queued 5 applications. 10 blocked by safety gates.",
      tone: "success",
    });
  });

  it("names the missing-adapter case rather than looking broken", () => {
    const zero = result({
      requested: 2,
      blocked: 2,
      outcomes: [blockedBy("NO_ADAPTER_REGISTERED_FOR_SOURCE"), blockedBy("NO_ADAPTER_REGISTERED_FOR_SOURCE")],
    });

    expect(describeBulkApplyResult(zero)).toEqual({
      text: "0 queued — no source supports automated submission yet.",
      tone: "default",
    });
  });

  it("does NOT claim the missing-adapter reason when some blocker is something else", () => {
    const mixed = result({
      requested: 2,
      blocked: 2,
      outcomes: [blockedBy("NO_ADAPTER_REGISTERED_FOR_SOURCE"), blockedBy("DAILY_APPLICATION_LIMIT_EXCEEDED", "rate_and_abuse_controls")],
    });

    const described = describeBulkApplyResult(mixed);

    expect(described.text).toBe("0 queued. 2 applications were blocked by safety gates.");
    expect(described.tone).toBe("default");
  });

  it("distinguishes a rate limit from the missing-adapter case", () => {
    const limited = result({
      requested: 30,
      blocked: 30,
      outcomes: [blockedBy("DAILY_APPLICATION_LIMIT_EXCEEDED", "rate_and_abuse_controls")],
    });

    expect(describeBulkApplyResult(limited).text).toBe(
      "0 queued. 30 applications were blocked by safety gates.",
    );
  });

  it("reports an all-errors result as an error", () => {
    expect(
      describeBulkApplyResult(
        result({ requested: 2, errors: 2, outcomes: [{ vacancyId: "v1", status: "error", blockingGates: [] }] }),
      ),
    ).toEqual({ text: "Could not queue any applications. 2 vacancies failed.", tone: "error" });
  });

  it("handles an empty request", () => {
    expect(describeBulkApplyResult(result())).toEqual({ text: "Nothing to queue.", tone: "default" });
  });

  it("treats partial success with errors as informational, not a failure", () => {
    const described = describeBulkApplyResult(result({ requested: 3, queued: 2, errors: 1 }));

    expect(described.text).toBe("Successfully queued 2 applications. 1 could not be processed.");
    expect(described.tone).toBe("default");
  });
});

describe("findActionableBlocker", () => {
  it("names plan_entitlement and points at billing", () => {
    const blocker = findActionableBlocker(
      result({ requested: 1, blocked: 1, outcomes: [blockedBy("plan_not_eligible", "plan_entitlement")] }),
    );

    expect(blocker?.gate).toBe("plan_entitlement");
    expect(blocker?.ctaHref).toBe("/billing");
    expect(blocker?.ctaLabel).toBe("See plans");
  });

  it("names location and points at profile", () => {
    const blocker = findActionableBlocker(
      result({ requested: 1, blocked: 1, outcomes: [blockedBy("location_not_stated", "location")] }),
    );

    expect(blocker?.gate).toBe("location");
    expect(blocker?.reasonCode).toBe("location_not_stated");
    expect(blocker?.ctaHref).toBe("/profile");
  });

  it("stays silent for a gate the candidate cannot act on", () => {
    // The expected state today: no adapter is registered for any source, so there
    // is nothing the candidate can fix and nothing to prompt about. A dialog here
    // would be a dead end pointing at a screen with no remedy.
    expect(
      findActionableBlocker(
        result({ requested: 1, blocked: 1, outcomes: [blockedBy("NO_ADAPTER_REGISTERED_FOR_SOURCE")] }),
      ),
    ).toBeNull();
  });

  it("ignores errored and queued outcomes", () => {
    expect(
      findActionableBlocker(
        result({
          requested: 2,
          errors: 1,
          outcomes: [
            { vacancyId: "v1", status: "error", blockingGates: [] },
            { vacancyId: "v2", status: "queued", blockingGates: [] },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("returns the first actionable gate when several vacancies are blocked", () => {
    const blocker = findActionableBlocker(
      result({
        requested: 2,
        blocked: 2,
        outcomes: [
          blockedBy("NO_ADAPTER_REGISTERED_FOR_SOURCE"),
          blockedBy("plan_not_eligible", "plan_entitlement"),
        ],
      }),
    );

    expect(blocker?.gate).toBe("plan_entitlement");
  });

  it("returns null for an empty result", () => {
    expect(findActionableBlocker(result())).toBeNull();
  });
});
