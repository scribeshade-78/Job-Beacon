import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  }),
}));

import { AutoApplyLimitsPanel } from "./AutoApplyLimitsPanel";

/** The response shape /api/billing/subscription actually returns. */
function subscription(opts: {
  indiaLimit?: number | null;
  usLimit?: number | null;
  consumed?: number;
  india?: number;
  us?: number;
}) {
  return {
    entitlements: {
      evaluations: [
        // === undefined ? 25, NOT ?? 25: an explicit null means UNLIMITED here, and ?? would
        // quietly turn it back into 25 so the unlimited branch could never be reached.
        { dimension: "auto_apply_india_per_month", prdLabel: "Auto-apply, India jobs (per week)", limit: opts.indiaLimit === undefined ? 25 : opts.indiaLimit, usage: opts.india ?? 0, remaining: null },
        { dimension: "auto_apply_us_per_month", prdLabel: "Auto-apply, US jobs (per week)", limit: opts.usLimit === undefined ? 25 : opts.usLimit, usage: opts.us ?? 0, remaining: null },
      ],
    },
    autoApplyUsage: {
      consumedThisPeriod: opts.consumed ?? 0,
      indiaConsumed: opts.india ?? 0,
      usConsumed: opts.us ?? 0,
    },
  };
}

function mockFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// CLEANUP IS EXPLICIT BECAUSE THIS PROJECT DOES NOT SET vitest globals: true.
// React Testing Library only auto-unmounts when afterEach is a global, so without this
// every render accumulates in the same jsdom document and getByText("India") finds the
// previous test's card as well as this one's.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutoApplyLimitsPanel", () => {
  it("renders each destination against its WEEKLY limit", async () => {
    mockFetch(subscription({ indiaLimit: 25, usLimit: 40, india: 2, us: 1, consumed: 3 }));
    render(<AutoApplyLimitsPanel />);

    await waitFor(() => expect(screen.getByText("India")).toBeTruthy());
    expect(screen.getByText("2 / 25")).toBeTruthy();
    expect(screen.getByText("1 / 40")).toBeTruthy();
    expect(screen.getByText(/reset weekly/i)).toBeTruthy();
  });

  it("SHOWS the unattributed remainder when the split does not account for everything", async () => {
    // The case that matters: 7 consumed, 2 + 1 attributed, so 4 belong to no destination.
    mockFetch(subscription({ india: 2, us: 1, consumed: 7 }));
    render(<AutoApplyLimitsPanel />);

    await waitFor(() => expect(screen.getByText("India")).toBeTruthy());
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText(/could not be attributed to a destination/i)).toBeTruthy();
  });

  it("HIDES the remainder when the split accounts for everything", async () => {
    mockFetch(subscription({ india: 2, us: 1, consumed: 3 }));
    render(<AutoApplyLimitsPanel />);

    await waitFor(() => expect(screen.getByText("India")).toBeTruthy());
    expect(screen.queryByText(/could not be attributed/i)).toBeNull();
  });

  it("CLAMPS the remainder at 0 rather than rendering a negative count", async () => {
    // A transient inconsistency must never show "-1 applications".
    mockFetch(subscription({ india: 5, us: 5, consumed: 3 }));
    render(<AutoApplyLimitsPanel />);

    await waitFor(() => expect(screen.getByText("India")).toBeTruthy());
    expect(screen.queryByText(/could not be attributed/i)).toBeNull();
    expect(screen.queryByText(/-\d/)).toBeNull();
  });

  it("renders an unlimited allowance as a count, never as a slash with nothing after it", async () => {
    mockFetch(subscription({ indiaLimit: null, usLimit: null, india: 3, us: 0, consumed: 3 }));
    render(<AutoApplyLimitsPanel />);

    await waitFor(() => expect(screen.getByText("India")).toBeTruthy());
    expect(screen.getByText("3 sent")).toBeTruthy();
    expect(screen.queryByText(/3 \/ /)).toBeNull();
  });

  it("surfaces a failed read instead of showing zeroes", async () => {
    mockFetch({}, false);
    render(<AutoApplyLimitsPanel />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/Could not load/i);
  });
});
