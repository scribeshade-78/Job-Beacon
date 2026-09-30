import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    })),
    listOpportunitiesByIds: vi.fn(async () => ({ kind: "success", opportunities: [], hasMore: false })),
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
