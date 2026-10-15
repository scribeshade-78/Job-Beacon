import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_MONITOR_INTERVAL_MS,
  describeDiscoveryResult,
  describeRefreshResult,
  discoverLiveJobs,
  readIntakeRefreshStatus,
  refreshOpportunities,
  type DiscoverySourceSummary,
  type IngestionRefreshResult,
  type LiveDiscoveryResult,
} from "./ingestion";

/**
 * Task A1. refreshOpportunities (above) drains the server's ingestion_jobs
 * queue and is kept for the scheduled-worker path; discoverLiveJobs is what the
 * "Fetch latest jobs" button now calls, because nothing in this repository ever
 * fills that queue.
 */
const REMOTIVE_SOURCE: DiscoverySourceSummary = {
  sourceCode: "remotive",
  displayName: "Remotive (public remote-job API)",
  attribution: "Job data from Remotive (https://remotive.com), delayed by 24 hours.",
  status: "ok",
  search: null,
  received: 16,
  ingested: 6,
  created: 2,
  updated: 4,
  skippedByAdapter: 0,
  newVacancyIds: ["vac-1", "vac-2"],
  trustStatusCounts: { VERIFIED_INCOMPLETE: 6 },
  durationMs: 2500,
};

/** A source the fan-out skipped — no source_policies row, kill switch, or down. */
function failedSource(sourceCode: string, displayName: string, error = "HTTP 503"): DiscoverySourceSummary {
  return {
    sourceCode,
    displayName,
    attribution: "",
    status: "failed",
    error,
    search: null,
    received: 0,
    ingested: 0,
    created: 0,
    updated: 0,
    skippedByAdapter: 0,
    newVacancyIds: [],
    trustStatusCounts: {},
    durationMs: 12,
  };
}

/** The aggregate the server returns for a fan-out run. */
function discoveryResult(over: Partial<LiveDiscoveryResult> = {}): LiveDiscoveryResult {
  return {
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
    failedSources: 0,
    sources: [REMOTIVE_SOURCE],
    ...over,
  };
}

const DISCOVERY_RESULT: LiveDiscoveryResult = discoveryResult();

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
  const noSleep = async () => {};

  /** The 202 the POST answers with now that the fan-out left the request path. */
  function queued(): Response {
    return jsonResponse(202, { status: "queued", enqueued: true, alreadyRunning: false, jobId: "job-1" });
  }

  /** One poll of the monitor. running defaults to false so a settled state is explicit. */
  function monitor(over: Record<string, unknown> = {}): Response {
    return jsonResponse(200, { status: "done", running: false, result: null, lastError: null, updatedAt: null, ...over });
  }

  function fetchQueue(...responses: Response[]) {
    const fetchImpl = vi.fn();
    for (const response of responses) {
      fetchImpl.mockResolvedValueOnce(response);
    }
    return fetchImpl;
  }

  it("queues with a POST and then monitors with GET, instead of awaiting the fan-out", async () => {
    // THE CONTRACT CHANGE. The POST used to hold the connection open for a sequential
    // fan-out that can take minutes; it now returns 202 and the work is watched.
    const fetchImpl = fetchQueue(queued(), monitor({ result: DISCOVERY_RESULT }));

    await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/intake/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer token-123" },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/intake/discover", {
      headers: { Authorization: "Bearer token-123" },
    });
  });

  it("returns the stored result once the monitor reports the job done", async () => {
    const fetchImpl = fetchQueue(queued(), monitor({ status: "done", result: DISCOVERY_RESULT }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome).toEqual({ kind: "success", result: DISCOVERY_RESULT });
  });

  it("keeps polling while the job is leased and stops as soon as it settles", async () => {
    const fetchImpl = fetchQueue(
      queued(),
      monitor({ status: "leased", running: true }),
      monitor({ status: "leased", running: true }),
      monitor({ status: "done", result: DISCOVERY_RESULT }),
    );

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome).toEqual({ kind: "success", result: DISCOVERY_RESULT });
    // POST + three polls; the loop must not keep asking after the job settled.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("reports a failed background refresh with the reason the drain recorded", async () => {
    const fetchImpl = fetchQueue(queued(), monitor({ status: "failed", lastError: "jooble is down" }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome).toEqual({ kind: "error", message: "jooble is down" });
  });

  it("hands off after a SHORT foreground budget rather than spinning for minutes", async () => {
    // The drain runs on the scheduler's cadence, so watching a refresh to completion
    // would hold the candidate on a spinner for minutes. The button watches briefly and
    // the panel's persistent indicator takes over from there.
    const fetchImpl = vi.fn(async () => monitor({ status: "pending", running: true }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome.kind).toBe("pending");
    // One POST, the immediate read, then the bounded remainder of the budget.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(BACKGROUND_MONITOR_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("gives up gracefully when the work is still running, rather than calling it a failure", async () => {
    // A bounded poll, not an infinite spinner. The work is queued and will finish, so
    // reporting an error would tell the candidate to retry work already in flight.
    const fetchImpl = vi.fn(async () => monitor({ status: "pending", running: true }));

    const outcome = await discoverLiveJobs({
      fetchImpl: fetchImpl as never,
      getAccessToken: token,
      sleep: noSleep,
      maxPolls: 2,
    });

    expect(outcome.kind).toBe("pending");
    if (outcome.kind === "pending") {
      expect(outcome.message).toMatch(/background/i);
    }
    // maxPolls bounds the polling: the initial POST plus maxPolls + 1 monitor reads.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("makes no request at all without a session", async () => {
    const fetchImpl = vi.fn();

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: async () => null });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("error");
  });

  it("maps 401 to a re-authenticate message", async () => {
    const fetchImpl = fetchQueue(jsonResponse(401, { error: "Unauthorized" }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("surfaces the server's own message when it says something actionable", async () => {
    // A typo in sourceCode is a 400 with the registered list; replacing it with
    // "something went wrong" would hide the only useful part.
    const fetchImpl = fetchQueue(
      jsonResponse(400, { error: "Unknown intake source. Registered: remotive." }),
    );

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("Unknown intake source");
    }
  });

  it("falls back to its own copy when the server sends no usable message", async () => {
    const fetchImpl = fetchQueue(jsonResponse(500, {}));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome).toEqual({ kind: "error", message: "Could not fetch new jobs. Please try again." });
  });

  it("names the rate limit rather than reporting a failure", async () => {
    const fetchImpl = fetchQueue(jsonResponse(429, { error: "Too many" }));

    const outcome = await discoverLiveJobs({ fetchImpl: fetchImpl as never, getAccessToken: token, sleep: noSleep });

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toMatch(/wait a few minutes/i);
    }
  });
});

/**
 * The monitor read on its own. The panel calls this on mount and while its background
 * indicator is showing, so a refresh started on an earlier visit is still visible.
 */
describe("readIntakeRefreshStatus", () => {
  it("reads the monitor with the caller's bearer token and returns the status", async () => {
    const status = { status: "leased", running: true, result: null, lastError: null, updatedAt: null };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, status));

    const outcome = await readIntakeRefreshStatus({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(fetchImpl).toHaveBeenCalledWith("/api/intake/discover", {
      headers: { Authorization: "Bearer token-123" },
    });
    expect(outcome).toEqual({ kind: "success", status });
  });

  it("returns the stored summary for a finished refresh", async () => {
    const status = {
      status: "done",
      running: false,
      result: DISCOVERY_RESULT,
      lastError: null,
      updatedAt: "2026-10-15T12:00:00.000Z",
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, status));

    const outcome = await readIntakeRefreshStatus({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "success", status });
  });

  it("maps 401 to a re-authenticate message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));

    const outcome = await readIntakeRefreshStatus({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("returns an error value rather than throwing when the read fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const outcome = await readIntakeRefreshStatus({ fetchImpl: fetchImpl as never, getAccessToken: token });

    expect(outcome.kind).toBe("error");
  });

  it("makes no request at all without a session", async () => {
    const fetchImpl = vi.fn();

    const outcome = await readIntakeRefreshStatus({ fetchImpl: fetchImpl as never, getAccessToken: async () => null });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("error");
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
