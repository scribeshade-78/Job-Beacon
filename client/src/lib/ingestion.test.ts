import { describe, expect, it, vi } from "vitest";
import {
  describeDiscoveryResult,
  describeRefreshResult,
  discoverLiveJobs,
  refreshOpportunities,
  type IngestionRefreshResult,
  type LiveDiscoveryResult,
} from "./ingestion";

/**
 * Task A1. refreshOpportunities (above) drains the server's ingestion_jobs
 * queue and is kept for the scheduled-worker path; discoverLiveJobs is what the
 * "Fetch latest jobs" button now calls, because nothing in this repository ever
 * fills that queue.
 */
const DISCOVERY_RESULT: LiveDiscoveryResult = {
  sourceCode: "remotive",
  displayName: "Remotive (public remote-job API)",
  attribution: "Job data from Remotive (https://remotive.com), delayed by 24 hours.",
  search: null,
  received: 16,
  ingested: 6,
  created: 2,
  updated: 4,
  newVacancyIds: ["vac-1", "vac-2"],
  fitAnalyzed: 2,
  fitPending: 0,
  fitStoppedOnDeadline: false,
  fitError: null,
  skippedByAdapter: 0,
  trustStatusCounts: { VERIFIED_INCOMPLETE: 6 },
  durationMs: 2500,
};

function result(overrides: Partial<IngestionRefreshResult> = {}): IngestionRefreshResult {
  return {
    targets: [],
    vacanciesFetched: 0,
    failed: 0,
    skippedRecent: 0,
    skippedQueued: 0,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const token = async () => "token-123";

describe("refreshOpportunities", () => {
  it("posts with the caller's bearer token and returns the batch summary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, result({ vacanciesFetched: 75 })),
    );

    const outcome = await refreshOpportunities({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(fetchImpl).toHaveBeenCalledWith("/api/opportunities/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer token-123" },
    });
    expect(outcome).toEqual({ kind: "success", result: result({ vacanciesFetched: 75 }) });
  });

  it("does not call the endpoint when there is no session", async () => {
    const fetchImpl = vi.fn();

    const outcome = await refreshOpportunities({ fetchImpl: fetchImpl as never, getAccessToken: async () => null });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("error");
  });

  it("maps 401 to a re-authenticate message rather than a generic failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));

    const outcome = await refreshOpportunities({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("explains the rate limit rather than reporting a generic error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: "Too many" }));

    const outcome = await refreshOpportunities({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/refreshed recently/i);
    }
  });

  it("returns an error result instead of throwing when the network fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const outcome = await refreshOpportunities({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("describeRefreshResult", () => {
  it("reports the fetched count", () => {
    expect(describeRefreshResult(result({ vacanciesFetched: 75 }))).toBe("Fetched 75 jobs.");
  });

  it("uses the singular for one job", () => {
    expect(describeRefreshResult(result({ vacanciesFetched: 1 }))).toBe("Fetched 1 job.");
  });

  it("says nothing new when every target was inside the cooldown", () => {
    expect(describeRefreshResult(result({ skippedRecent: 2 }))).toMatch(/already up to date/i);
  });

  it("reports a total failure as an error, not as an empty refresh", () => {
    expect(describeRefreshResult(result({ failed: 2 }))).toBe(
      "Could not fetch jobs from any source. Please try again later.",
    );
  });

  it("acknowledges a partial failure without hiding the successes", () => {
    expect(describeRefreshResult(result({ vacanciesFetched: 50, failed: 1 }))).toBe(
      "Fetched 50 jobs. Some sources could not be reached.",
    );
  });
});

describe("discoverLiveJobs", () => {
  it("posts to the intake endpoint, not the queue-draining one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DISCOVERY_RESULT));

    await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(fetchImpl).toHaveBeenCalledWith("/api/intake/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-123" },
    });
  });

  it("returns the parsed result, including the ids of what was created", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, DISCOVERY_RESULT));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "success", result: DISCOVERY_RESULT });
  });

  it("makes no request at all without a session", async () => {
    const fetchImpl = vi.fn();

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: async () => null });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("error");
  });

  it("maps 401 to a re-authenticate message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("surfaces the server's own message when it says something actionable", async () => {
    // A switched-off source is a 409 with a real explanation; replacing it with
    // "something went wrong" would hide the only useful part.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(409, { error: 'Intake is not permitted for source "remotive": its kill_switch is on' }),
    );

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("kill_switch is on");
    }
  });

  it("falls back to its own copy when the server sends no usable message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "error", message: "Could not fetch new jobs. Please try again." });
  });

  it("names the rate limit rather than reporting a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: "Too many" }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/wait a few minutes/i);
    }
  });
});

describe("describeDiscoveryResult", () => {
  it("counts what was CREATED, not everything that was written", () => {
    // 6 written, 2 new. Saying "6 new jobs" would be wrong by a factor of three.
    expect(describeDiscoveryResult(DISCOVERY_RESULT)).toContain("2 new jobs");
  });

  it("says the new jobs were scored when they all were", () => {
    expect(describeDiscoveryResult(DISCOVERY_RESULT)).toBe("2 new jobs added and scored.");
  });

  it("uses the singular for one job", () => {
    expect(describeDiscoveryResult({ ...DISCOVERY_RESULT, created: 1, newVacancyIds: ["v"], fitAnalyzed: 1 })).toContain(
      "1 new job added",
    );
  });

  it("says how many were NOT scored, rather than implying all of them were", () => {
    // The bound is 5 per press. A run that creates 16 and scores 5 must say so,
    // or a candidate wonders where the other 11 went.
    const text = describeDiscoveryResult({ ...DISCOVERY_RESULT, created: 16, fitAnalyzed: 5, fitPending: 11 });

    expect(text).toContain("16 new jobs added");
    expect(text).toContain("5 scored");
    expect(text).toContain("11 still queued");
  });

  it("does not claim scoring when nothing was scored", () => {
    const text = describeDiscoveryResult({ ...DISCOVERY_RESULT, created: 3, fitAnalyzed: 0, fitPending: 3 });

    expect(text).toContain("aren't scored yet");
    expect(text).not.toContain("and scored");
  });

  it("reports a refresh-only run as no new jobs, not as a failure", () => {
    const text = describeDiscoveryResult({ ...DISCOVERY_RESULT, created: 0, newVacancyIds: [] });

    expect(text).toContain("No new jobs");
    expect(text).toContain("4 existing listings refreshed");
  });

  it("distinguishes an empty source response from a same-listings response", () => {
    const empty = describeDiscoveryResult({ ...DISCOVERY_RESULT, created: 0, updated: 0, received: 0 });
    const same = describeDiscoveryResult({ ...DISCOVERY_RESULT, created: 0, updated: 0, received: 16 });

    expect(empty).toContain("No jobs came back");
    expect(same).toContain("republishes the same listings");
    expect(empty).not.toBe(same);
  });
});
