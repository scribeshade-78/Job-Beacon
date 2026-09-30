import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";

/**
 * The internal job detail route, exercised through the REAL SignedInRoutes so
 * that the #/jobs/:jobId registration in App.tsx is what is under test rather
 * than a stand-in route declared by the test.
 *
 * The supabase double is table-aware rather than a canned answer: it filters
 * candidate_opportunities by the ids the caller actually asked for, so a page
 * that read the wrong id would render the wrong job and fail here.
 */

const fixtures = vi.hoisted(() => {
  const job = (id: string, title: string, url: string) => ({
    id,
    raw_title: title,
    authoritative_url: url,
    country: "India",
    region: null as string | null,
    city: "Bengaluru",
    remote_type: "remote",
    currency: "USD",
    salary_min: 120000,
    salary_max: 150000,
    salary_interval: "year",
    salary_source: "estimated",
    discovered_at: "2026-09-17T00:00:00Z",
    last_seen_at: "2026-09-17T00:00:00Z",
    expires_at: null as string | null,
    trust_status: "VERIFIED",
    source_code: "remotive",
    company_name: "Contoso",
    company_domain: "contoso.test",
    plan_gate_results: { eligible: true },
    attempt_status: null as string | null,
    technical_fit_score: 80,
    practical_eligibility_score: 100,
    eligibility_capped: false,
    hard_blockers: [] as Array<{ code: string; detail: string }>,
    missing_evidence: [] as string[],
    top_reasons: [] as string[],
    jd_text_available: true,
    priority_score: 70,
    priority_uncapped_score: 70,
    priority_components: null as Record<string, unknown> | null,
    priority_score_version: null as string | null,
  });

  return {
    jobs: [
      job("job-1", "Azure Data Engineer", "https://source.test/job-1"),
      job("job-2", "Product Designer", "https://source.test/job-2"),
    ],
    snapshots: {
      "job-1": { clean_text: "Build pipelines on Azure. Own the data platform end to end." },
      "job-2": { clean_text: "Design product flows." },
    } as Record<string, { clean_text: string }>,
  };
});

vi.mock("../lib/supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    from: (table: string) => {
      const builder: any = {};
      let ids: string[] = [];
      let vacancyId: string | null = null;

      builder.select = () => builder;
      builder.in = (_column: string, values: string[]) => {
        ids = values;
        return builder;
      };
      builder.eq = (column: string, value: string) => {
        if (column === "vacancy_id") vacancyId = value;
        return builder;
      };
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = async () =>
        table === "vacancy_jd_snapshots"
          ? { data: vacancyId === null ? null : fixtures.snapshots[vacancyId] ?? null, error: null }
          : { data: null, error: null };
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "candidate_opportunities"
              ? fixtures.jobs.filter((entry) => ids.includes(entry.id))
              : [],
          error: null,
        }).then(resolve);

      return builder;
    },
  }),
}));

import { SignedInRoutes } from "../App";
import { capabilitiesFromIdentity } from "../lib/capabilities";

const CANDIDATE = capabilitiesFromIdentity({ isModerator: false, isAdmin: false, isEmployer: false });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function renderAt(path: string) {
  window.location.hash = "#" + path;

  return render(
    <Router hook={useHashLocation}>
      <SignedInRoutes
        candidateId="candidate-1"
        ready
        email="candidate@example.test"
        capabilities={CANDIDATE}
        capabilitiesPending={false}
        identityError={null}
        profileError={null}
        onLogout={() => {}}
      />
    </Router>,
  );
}

describe("#/jobs/:jobId", () => {
  it("renders the job the id names, and not another job", async () => {
    renderAt("/jobs/job-1");

    expect(await screen.findByText("Azure Data Engineer")).toBeTruthy();
    expect(screen.getByText("Contoso")).toBeTruthy();
    expect(screen.getByText("· Bengaluru, India")).toBeTruthy();
    expect(screen.getByText("Remote")).toBeTruthy();
    expect(screen.getByText(/150,000/)).toBeTruthy();
    expect(screen.getByText(/Build pipelines on Azure/)).toBeTruthy();
    expect(screen.queryByText("Product Designer")).toBeNull();
  });

  it("keeps the outbound link on the detail page, pointing at the original URL", async () => {
    renderAt("/jobs/job-1");

    const link = await screen.findByRole("link", { name: /Open original job posting/ });
    expect(link.getAttribute("href")).toBe("https://source.test/job-1");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("reports a missing listing instead of rendering an empty page", async () => {
    renderAt("/jobs/does-not-exist");

    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
  });
});
