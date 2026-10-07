import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";

/**
 * The job title in the list is the entry point to the internal detail page.
 *
 * The data layer is mocked on purpose: what is under test is WHERE the link
 * points and how the trust badge is presented, not how the list is fetched
 * (that has its own suite in lib/opportunities.test.ts). The board URL is still
 * in the fixture, so a link that quietly kept using it would fail here.
 */

const fixtures = vi.hoisted(() => ({
  opportunity: {
    id: "job-1",
    title: "Azure Data Engineer",
    url: "https://source.test/job-1",
    companyName: "Contoso",
    companyDomain: "contoso.test",
    location: "Bengaluru, India",
    remoteType: "remote",
    // Production's common case: an aggregator-tier source, so the badge, the
    // page-level banner and the (absent) per-card paragraph are all exercised.
    trustStatus: "UNDER_REVIEW",
    sourceCode: "remotive",
    salary: { min: 120000, max: 150000, currency: "USD", interval: "year", source: "estimated" },
    discoveredAt: "2026-09-17T00:00:00Z",
    lastSeenAt: "2026-09-17T00:00:00Z",
    autoApplyStatus: "not_started",
    fitAnalysis: null,
    evidenceState: "current",
    matchedQualifierCount: 0,
  },
  ranking: {
    state: "updating",
    identity: "state=updating|q=-|r=-|cv=-|mv=-|tv=-|ei=-|ec=0",
    roleMatchGeneration: null,
    corpusVersion: null,
    matcherVersion: null,
    qualifierGeneration: null,
    tokenizerVersion: null,
    evidenceIndexedAt: null,
    evidenceRowCount: 0,
  },
  preferences: {
    preferredCountries: [],
    preferredCities: [],
    remotePreference: null,
    employmentTypes: [],
    workAuthorization: null,
    requiresSponsorship: null,
    minSalary: null,
    minSalaryCurrency: null,
    willingToRelocate: null,
    excludedCompanies: [],
    excludedIndustries: [],
    openToAnyLocation: false,
  },
}));

vi.mock("../lib/supabaseClient", () => ({ getSupabaseBrowserClient: () => ({}) }));

const rankingApi = vi.hoisted(() => ({ runRankingRefresh: vi.fn() }));

vi.mock("../lib/feedRankingRefresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/feedRankingRefresh")>();
  return { ...actual, runRankingRefresh: rankingApi.runRankingRefresh };
});

vi.mock("../lib/opportunities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/opportunities")>();
  return {
    ...actual,
    listOpportunities: vi.fn(async () => ({
      kind: "success",
      opportunities: [fixtures.opportunity],
      hasMore: false,
      totalCount: 1,
      ranking: fixtures.ranking,
    })),
    listOpportunitiesByIds: vi.fn(async () => ({
      kind: "success",
      opportunities: [],
      hasMore: false,
      totalCount: 0,
      ranking: fixtures.ranking,
    })),
    formatSalary: () => "USD 120,000-150,000/year (estimated)",
  };
});

vi.mock("../lib/candidatePreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/candidatePreferences")>();
  return {
    ...actual,
    loadCandidatePreferences: vi.fn(async () => ({ kind: "success", preferences: fixtures.preferences })),
  };
});

// Capability and the bulk-apply call are configurable per test. The default
// ("no source can queue") keeps every pre-existing test on the disabled-button
// path; the blocker tests below turn both on in order to reach the click.
const capabilityApi = vi.hoisted(() => ({ canQueue: false, explanation: "No source yet." }));
const bulkApi = vi.hoisted(() => ({ submitBulkApply: vi.fn() }));

vi.mock("../lib/queueCapability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/queueCapability")>();
  return {
    ...actual,
    fetchQueueCapability: vi.fn(async () => ({
      kind: "ready",
      canQueue: capabilityApi.canQueue,
      explanation: capabilityApi.explanation,
    })),
  };
});

vi.mock("../lib/bulkApply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bulkApply")>();
  return { ...actual, submitBulkApply: bulkApi.submitBulkApply };
});

import { OpportunitiesPanel } from "./OpportunitiesPanel";
import { listOpportunities } from "../lib/opportunities";

afterEach(cleanup);

beforeEach(() => {
  // The panel now asks the server to do real refresh work when its state is not
  // current. Default the poll to its cap so no test reaches the network; the
  // refresh-specific tests override this.
  rankingApi.runRankingRefresh.mockResolvedValue({ kind: "timeout", result: null });
  capabilityApi.canQueue = false;
  bulkApi.submitBulkApply.mockReset();
});

function renderPanel() {
  return render(
    <Router hook={useHashLocation}>
      <OpportunitiesPanel candidateId="candidate-1" />
    </Router>,
  );
}

describe("OpportunitiesPanel job links", () => {
  it("points the job title at the internal detail route, not the job board", async () => {
    renderPanel();

    const link = await screen.findByRole("link", { name: "Azure Data Engineer" });

    expect(link.getAttribute("href")).toBe("#/jobs/job-1");
    // No target: the internal route replaces the view rather than opening a tab.
    expect(link.getAttribute("target")).toBeNull();
  });

  it("no longer renders the outbound board link on the card", async () => {
    renderPanel();

    // The labelled outbound link moved to the detail page; the list must not
    // offer a second way out of the app.
    expect(await screen.findByText("Azure Data Engineer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open original job posting/ })).toBeNull();
  });

  it("explains the trust badge once at page level instead of on every card", async () => {
    renderPanel();

    expect(await screen.findByText("Azure Data Engineer")).toBeTruthy();
    // One page-level explanation...
    expect(screen.getByText(/Some listings come from sources we can/)).toBeTruthy();
    // ...and the full paragraph is no longer repeated for every card.
    expect(screen.queryByText(/We haven/)).toBeNull();
  });
});

describe("OpportunitiesPanel — ranking generation identity", () => {
  const pageOneOpportunity = {
    ...fixtures.opportunity,
    id: "job-1",
    title: "Azure Data Engineer",
  };
  const otherOpportunity = {
    ...fixtures.opportunity,
    id: "job-2",
    title: "Teacher Role",
  };
  const rankingA = { ...fixtures.ranking, identity: "state=updating|q=a" };
  const rankingB = { ...fixtures.ranking, identity: "state=updating|q=b" };

  function page(opportunities: unknown[], ranking: unknown, hasMore: boolean) {
    return { kind: "success", opportunities, hasMore, totalCount: opportunities.length, ranking };
  }

  it("resets to the fresh page when the ranking identity changes between pages", async () => {
    vi.mocked(listOpportunities)
      .mockResolvedValueOnce(page([pageOneOpportunity], rankingA, true) as never)
      .mockResolvedValueOnce(page([otherOpportunity], rankingB, false) as never);

    renderPanel();
    await screen.findByText("Azure Data Engineer");

    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    // The second page belongs to a different generation: it REPLACES page one
    // rather than being appended to a list ranked under another identity.
    await screen.findByText("Teacher Role");
    expect(screen.queryByText("Azure Data Engineer")).toBeNull();
  });

  it("ignores an obsolete load-more response superseded by a newer read", async () => {
    let resolveLoadMore: (value: unknown) => void = () => {};
    const deferred = new Promise((resolve) => {
      resolveLoadMore = resolve;
    });

    vi.mocked(listOpportunities)
      .mockResolvedValueOnce(page([pageOneOpportunity], rankingA, true) as never)
      .mockReturnValueOnce(deferred as never)
      .mockResolvedValueOnce(page([pageOneOpportunity], rankingA, true) as never);

    renderPanel();
    await screen.findByText("Azure Data Engineer");

    // Start a load-more, then force a NEWER read (Retry re-runs the one read
    // effect), which makes the in-flight page obsolete.
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

    resolveLoadMore(page([otherOpportunity], rankingA, false));

    await waitFor(() => expect(screen.queryByText("Teacher Role")).toBeNull());
    expect(screen.getByText("Azure Data Engineer")).toBeTruthy();
  });
});

describe("OpportunitiesPanel — real ranking refresh", () => {
  it("requests the refresh when the loaded state is updating, and Retry forces the real path", async () => {
    rankingApi.runRankingRefresh.mockResolvedValue({ kind: "timeout", result: null });

    renderPanel();
    await screen.findByText("Azure Data Engineer");

    await waitFor(() =>
      expect(rankingApi.runRankingRefresh).toHaveBeenCalledWith(expect.objectContaining({ force: false })),
    );

    rankingApi.runRankingRefresh.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(rankingApi.runRankingRefresh).toHaveBeenCalledWith(expect.objectContaining({ force: true })),
    );
  });
});

describe("OpportunitiesPanel — actionable blocker prompt", () => {
  function blockedByPlan() {
    return {
      kind: "success",
      result: {
        requested: 1,
        queued: 0,
        blocked: 1,
        errors: 0,
        outcomes: [
          {
            vacancyId: "job-1",
            status: "blocked",
            blockingGates: [{ gate: "plan_entitlement", reasonCode: "plan_not_eligible" }],
          },
        ],
      },
    };
  }

  it("names the plan gate and offers plans, instead of only showing a toast", async () => {
    capabilityApi.canQueue = true;
    bulkApi.submitBulkApply.mockResolvedValue(blockedByPlan());

    renderPanel();

    await screen.findByText("Azure Data Engineer");
    // Re-queried inside waitFor: the button is re-rendered as capability and the
    // list resolve, so a reference captured once can be detached by the time it
    // is asserted against. toBeEnabled() comes from vitest.setup.ts.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Queue eligible applications/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Queue eligible applications/i }));

    // The gate the SERVER named, turned into something the candidate can act on.
    expect(await screen.findByText("Automatic applications need a paid plan")).toBeTruthy();
    expect(screen.getByRole("button", { name: "See plans" })).toBeTruthy();
  });

  it("stays silent when the blocking gate is not the candidate's to fix", async () => {
    capabilityApi.canQueue = true;
    bulkApi.submitBulkApply.mockResolvedValue({
      kind: "success",
      result: {
        requested: 1,
        queued: 0,
        blocked: 1,
        errors: 0,
        outcomes: [
          {
            vacancyId: "job-1",
            status: "blocked",
            blockingGates: [{ gate: "application_support", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" }],
          },
        ],
      },
    });

    renderPanel();

    await screen.findByText("Azure Data Engineer");
    // Re-queried inside waitFor: the button is re-rendered as capability and the
    // list resolve, so a reference captured once can be detached by the time it
    // is asserted against. toBeEnabled() comes from vitest.setup.ts.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Queue eligible applications/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Queue eligible applications/i }));

    await waitFor(() => expect(bulkApi.submitBulkApply).toHaveBeenCalled());
    // No adapter exists: there is no screen that would fix it, so a dialog would be
    // a dead end. The plain toast (asserted in lib/bulkApply.test.ts) is the whole
    // answer here.
    expect(screen.queryByText("Automatic applications need a paid plan")).toBeNull();
    expect(screen.queryByText("Tell us where you want to work")).toBeNull();
    expect(screen.queryByRole("button", { name: "See plans" })).toBeNull();
  });
});
