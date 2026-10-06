import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../lib/queueCapability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/queueCapability")>();
  return {
    ...actual,
    fetchQueueCapability: vi.fn(async () => ({ kind: "ready", canQueue: false, explanation: "No source yet." })),
  };
});

import { OpportunitiesPanel } from "./OpportunitiesPanel";
import { listOpportunities } from "../lib/opportunities";

afterEach(cleanup);

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
