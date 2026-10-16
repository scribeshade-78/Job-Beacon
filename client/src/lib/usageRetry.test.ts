import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
  }),
}));
vi.mock("../components/ui/use-toast", () => ({ showToast: vi.fn() }));

import { showToast } from "../components/ui/use-toast";
import {
  DISCOVERY_REPORT_FAILURE_MARKER,
  reportDiscoverySurfaces,
  resetDiscoveryReportState,
} from "./usage";

/**
 * A QUOTA LIMIT IS A STATE, NOT AN OUTAGE.
 *
 * The reporter retried every non-ok response and counted every one as a failure. For a 429 that
 * is exactly backwards: the server answered correctly, told the client the allowance is spent,
 * and told it when it resets. Retrying it is a self-inflicted loop against our own API, and
 * incrementing consecutiveFailures raises a toast claiming "we're already retrying" about a
 * condition no retry can change.
 *
 * The rule these pin: RETRY ONLY WHAT COULD DIFFER ON A SECOND ATTEMPT. A 5xx might; a 4xx will
 * not, because the request itself was rejected.
 */

function reply(status: number, body = ""): () => Promise<Response> {
  return async () => new Response(body, { status });
}

describe("discovery-surface reporting: which failures may be retried", () => {
  beforeEach(() => {
    resetDiscoveryReportState();
    vi.clearAllMocks();
  });

  it("does NOT retry a 429 quota exhaustion", async () => {
    const fetchImpl = vi.fn(reply(429, JSON.stringify({ code: "QUOTA_EXHAUSTED" })));

    await reportDiscoverySurfaces(["a"], fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not report a 429 as a failure or raise a notice for it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 5; i += 1) {
      await reportDiscoverySurfaces(["a"], reply(429, "{}") as unknown as typeof fetch);
    }

    expect(error).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("still retries a 5xx, which a second attempt could succeed on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(reply(500, "boom"));

    await reportDiscoverySurfaces(["a"], fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("does not retry a 400, whose request was rejected as sent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(reply(400, "bad"));

    await reportDiscoverySurfaces(["a"], fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
