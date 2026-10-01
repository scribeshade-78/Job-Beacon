import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_CHECK_FAILED,
  describeAutomationCapabilityNotice,
  describeBulkApplyButton,
  describeLoadedCount,
  fetchQueueCapability,
  type QueueCapabilityState,
} from "./queueCapability";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const token = async () => "token-123";

const READY_UNAVAILABLE: QueueCapabilityState = {
  kind: "ready",
  canQueue: false,
  explanation: "Automatic submission unavailable — no available job source supports it yet.",
};

const READY_AVAILABLE: QueueCapabilityState = {
  kind: "ready",
  canQueue: true,
  explanation: "Automatic applications are available.",
};

describe("fetchQueueCapability", () => {
  it("reads the endpoint with the caller's bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { canQueue: true, explanation: "ok" }));

    const state = await fetchQueueCapability({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(fetchImpl).toHaveBeenCalledWith("/api/opportunities/capability", {
      method: "GET",
      headers: { Authorization: "Bearer token-123" },
    });
    expect(state).toEqual({ kind: "ready", canQueue: true, explanation: "ok" });
  });

  /**
   * A FAILED READ MUST NOT BECOME "UNAVAILABLE". Claiming sources are
   * unavailable because a request failed would state something about the
   * product that the failure cannot justify.
   */
  it("reports a transport failure as an error, never as unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const state = await fetchQueueCapability({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.message).toBe(CAPABILITY_CHECK_FAILED);
  });

  it("reports a 500 as an error, never as unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));

    const state = await fetchQueueCapability({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
  });

  it("reports a malformed payload as an error rather than guessing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { canQueue: "yes" }));

    const state = await fetchQueueCapability({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
  });

  it("does not call the endpoint without a session", async () => {
    const fetchImpl = vi.fn();

    const state = await fetchQueueCapability({
      fetchImpl: fetchImpl as never,
      getAccessToken: async () => null,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.kind).toBe("error");
  });
});

describe("describeBulkApplyButton", () => {
  it("disables the action and explains why when no source can queue", () => {
    const state = describeBulkApplyButton({
      capability: READY_UNAVAILABLE,
      visibleCount: 25,
      busy: false,
    });

    expect(state.disabled).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.notice).toBe(READY_UNAVAILABLE.explanation);
  });

  /**
   * THE LABEL IS THE BUG THIS REPLACES. "Apply to 25 loaded matches" promised an
   * action that cannot happen, and would still overstate it when it can: source
   * capability says nothing about each job's own gates.
   */
  it("never claims the loaded count is what will be applied to", () => {
    const state = describeBulkApplyButton({ capability: READY_AVAILABLE, visibleCount: 25, busy: false });

    expect(state.label).toBe("Queue eligible applications");
    expect(state.label).not.toContain("25");
    expect(state.label).not.toContain("Apply to");
  });

  it("enables the action only when capability is available and jobs are loaded", () => {
    const state = describeBulkApplyButton({ capability: READY_AVAILABLE, visibleCount: 3, busy: false });

    expect(state.disabled).toBe(false);
    expect(state.blocked).toBe(false);
    expect(state.notice).toBeNull();
  });

  it("stays disabled with nothing loaded even when capability is available", () => {
    const state = describeBulkApplyButton({ capability: READY_AVAILABLE, visibleCount: 0, busy: false });

    expect(state.disabled).toBe(true);
  });

  it("blocks the click while loading", () => {
    const state = describeBulkApplyButton({ capability: { kind: "loading" }, visibleCount: 5, busy: false });

    expect(state.disabled).toBe(true);
    expect(state.blocked).toBe(true);
  });

  it("surfaces the retry message on a failed check and does not blame sources", () => {
    const state = describeBulkApplyButton({
      capability: { kind: "error", message: CAPABILITY_CHECK_FAILED },
      visibleCount: 5,
      busy: false,
    });

    expect(state.disabled).toBe(true);
    expect(state.notice).toBe(CAPABILITY_CHECK_FAILED);
    expect(state.notice).toContain("Retry");
    // It must not assert anything about source availability.
    expect(state.notice?.toLowerCase()).not.toContain("no available job source");
  });

  it("shows progress and blocks a double submit while busy", () => {
    const state = describeBulkApplyButton({ capability: READY_AVAILABLE, visibleCount: 5, busy: true });

    expect(state.label).toBe("Queueing…");
    expect(state.blocked).toBe(true);
  });
});

describe("describeLoadedCount", () => {
  it("reports the count separately from the action", () => {
    expect(describeLoadedCount(1)).toBe("1 loaded job");
    expect(describeLoadedCount(25)).toBe("25 loaded jobs");
    expect(describeLoadedCount(0)).toBe("No jobs loaded");
  });
});

describe("describeAutomationCapabilityNotice", () => {
  it("explains that automatic submission is unavailable and that consent is kept", () => {
    const notice = describeAutomationCapabilityNotice(READY_UNAVAILABLE);

    expect(notice).toContain("Automatic submission unavailable");
    expect(notice).toContain("Your submission consent is saved");
  });

  it("shows nothing when an application can actually be queued", () => {
    expect(describeAutomationCapabilityNotice(READY_AVAILABLE)).toBeNull();
  });

  it("shows nothing while the check is still running", () => {
    expect(describeAutomationCapabilityNotice({ kind: "loading" })).toBeNull();
  });

  it("offers a retry on a failed check", () => {
    expect(describeAutomationCapabilityNotice({ kind: "error", message: "x" })).toBe(CAPABILITY_CHECK_FAILED);
  });
});
