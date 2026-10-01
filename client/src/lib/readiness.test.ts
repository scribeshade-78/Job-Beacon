import { describe, expect, it, vi } from "vitest";
import { READINESS_CHECK_FAILED, fetchReadiness } from "./readiness";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const token = async () => "token-123";

const VALID = {
  resumeReady: true,
  rolesReady: true,
  preferencesReady: true,
  consentReady: true,
  completedSteps: 4,
  totalSteps: 4,
  setupComplete: true,
  discoveryAvailable: true,
  reviewQueueAvailable: true,
  submissionAvailable: true,
  automationControlsAvailable: true,
  blockers: [],
  primaryState: "ready_for_review_queue",
  steps: [
    { id: "resume", label: "Resume", complete: true, detail: "Resume ready", action: null, timestamp: "2026-09-01T00:00:00.000Z" },
    { id: "target_roles", label: "Target roles", complete: true, detail: "Target roles selected", action: null, timestamp: null },
    { id: "search_preferences", label: "Search preferences", complete: true, detail: "Location and work mode saved", action: null, timestamp: null },
    { id: "submission_consent", label: "Submission consent", complete: true, detail: "Submission consent granted", action: null, timestamp: null },
  ],
};

describe("fetchReadiness", () => {
  it("reads the endpoint with the caller's bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, VALID));

    const state = await fetchReadiness({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(fetchImpl).toHaveBeenCalledWith("/api/readiness", {
      method: "GET",
      headers: { Authorization: "Bearer token-123" },
    });
    expect(state).toEqual({ kind: "ready", readiness: VALID });
  });

  /**
   * A MALFORMED PAYLOAD IS AN ERROR, NOT A GUESS. Completing a checklist entry
   * from a payload the server did not actually send would claim a step the
   * candidate may not have finished.
   */
  it("reports a malformed payload as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { steps: [] }));

    const state = await fetchReadiness({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.message).toBe(READINESS_CHECK_FAILED);
  });

  it("reports a payload with the wrong number of steps as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { ...VALID, steps: VALID.steps.slice(0, 3) }));

    const state = await fetchReadiness({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
  });

  it("reports a 500 as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));

    const state = await fetchReadiness({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
  });

  it("reports a transport failure as an error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const state = await fetchReadiness({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(state.kind).toBe("error");
  });

  it("reports a missing token as an error rather than assuming anything", async () => {
    const fetchImpl = vi.fn();

    const state = await fetchReadiness({ fetchImpl: fetchImpl as never, getAccessToken: async () => null });

    expect(state.kind).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
