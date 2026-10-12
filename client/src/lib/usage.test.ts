import { beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("../components/ui/use-toast", () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock("./supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  }),
}));

import {
  DISCOVERY_REPORT_FAILURE_MARKER,
  FAILURES_BEFORE_NOTICE,
  reportDiscoverySurfaces,
  resetDiscoveryReportState,
} from "./usage";

const VACANCY = ["11111111-1111-4111-8111-111111111111"];

/** A fetch that always 404s. */
const alwaysFourOhFour = (async () => ({ ok: false, status: 404, text: async () => "not found" })) as unknown as typeof fetch;
const alwaysOk = (async () => ({ ok: true, status: 200, text: async () => "" })) as unknown as typeof fetch;

describe("reportDiscoverySurfaces", () => {
  beforeEach(() => {
    showToast.mockClear();
    resetDiscoveryReportState();
  });

  it("NEVER throws into the feed - a reporting failure must not break the job list", async () => {
    await expect(reportDiscoverySurfaces(VACANCY, alwaysFourOhFour)).resolves.toBeUndefined();
  });

  it("logs a greppable marker when the endpoint refuses, instead of an empty catch", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);

    expect(errorSpy.mock.calls.some((call) => call[0] === DISCOVERY_REPORT_FAILURE_MARKER)).toBe(true);
    errorSpy.mockRestore();
  });

  it("checks response.ok - a body nobody reads would otherwise resolve happily on a 500", async () => {
    // The old client never looked at the status at all, so it could not have noticed
    // a failure even if it had wanted to.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const serverError = (async () => ({ ok: false, status: 500, text: async () => "boom" })) as unknown as typeof fetch;

    await reportDiscoverySurfaces(VACANCY, serverError);

    expect(errorSpy.mock.calls.some((call) => String(call[1]?.reason ?? "").includes("HTTP 500"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("tells the candidate ONCE, only after repeated consecutive failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < FAILURES_BEFORE_NOTICE - 1; i += 1) {
      await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);
    }
    expect(showToast).not.toHaveBeenCalled();

    await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);
    expect(showToast).toHaveBeenCalledTimes(1);

    // Once per session: a notice that repeats is noise.
    await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);
    expect(showToast).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("clears the streak on success, so a blip cannot accumulate into a notice", async () => {
    await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);
    await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);
    await reportDiscoverySurfaces(VACANCY, alwaysOk);
    await reportDiscoverySurfaces(VACANCY, alwaysFourOhFour);

    expect(showToast).not.toHaveBeenCalled();
  });

  it("does nothing at all for an empty batch", async () => {
    await reportDiscoverySurfaces([], alwaysFourOhFour);
    expect(showToast).not.toHaveBeenCalled();
  });
});
