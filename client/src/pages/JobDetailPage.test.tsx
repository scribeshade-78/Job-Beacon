import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";

/**
 * The internal job detail route, exercised through the REAL SignedInRoutes so
 * that the #/jobs/:jobId registration in App.tsx is what is under test rather
 * than a stand-in route declared by the test.
 *
 * The supabase double is table-aware rather than a canned answer: it filters
 * candidate_opportunities by the ids the caller actually asked for, resolves
 * the JD snapshot and the company profile by the keys the page passes, and
 * records vacancy_reports inserts so the report's payload can be asserted. A
 * page that read the wrong id, table or column therefore fails here.
 */

const fixtures = vi.hoisted(() => {
  function job(id: string, title: string, url: string) {
    return {
      id,
      raw_title: title,
      authoritative_url: url,
      country: "India" as string | null,
      region: null as string | null,
      city: "Bengaluru" as string | null,
      remote_type: "remote" as string | null,
      currency: "USD" as string | null,
      salary_min: 120000 as number | null,
      salary_max: 150000 as number | null,
      salary_interval: "year" as string | null,
      salary_source: "estimated" as string | null,
      discovered_at: "2026-09-17T00:00:00Z",
      last_seen_at: "2026-09-17T00:00:00Z",
      expires_at: null as string | null,
      trust_status: "VERIFIED",
      source_code: "remotive",
      company_name: "Contoso" as string | null,
      company_domain: "contoso.test" as string | null,
      plan_gate_results: { eligible: true },
      attempt_status: null as string | null,
      technical_fit_score: 80 as number | null,
      practical_eligibility_score: 100 as number | null,
      eligibility_capped: false,
      hard_blockers: [] as Array<{ code: string; detail: string }>,
      missing_evidence: [] as string[],
      top_reasons: [] as string[],
      jd_text_available: true,
      priority_score: 70 as number | null,
      priority_uncapped_score: 70 as number | null,
      priority_components: null as Record<string, unknown> | null,
      priority_score_version: null as string | null,
    };
  }

  const jobOne = job("job-1", "Azure Data Engineer", "https://source.test/job-1");
  jobOne.missing_evidence = ["Kubernetes", "Terraform"];
  jobOne.top_reasons = ["Strong Azure data platform overlap"];

  // Deliberately empty: every optional field is absent, so the page must label
  // each gap rather than render a blank line.
  const jobThree = job("job-3", "Mystery Role", "https://source.test/job-3");
  jobThree.salary_min = null;
  jobThree.salary_max = null;
  jobThree.company_name = null;
  jobThree.company_domain = null;
  jobThree.city = null;
  jobThree.country = null;

  return {
    jobs: [jobOne, job("job-2", "Product Designer", "https://source.test/job-2"), jobThree],
    snapshots: {
      "job-1": {
        clean_text: "Build pipelines on Azure. Own the data platform end to end.",
        sections: [
          { heading: "Responsibilities", body: "Build pipelines." },
          { heading: "Requirements", body: "Five years of Azure." },
        ],
        captured_at: "2026-09-17T00:00:00Z",
      },
      // No headings: the extractor's single unlabelled section is skipped here
      // so the clean_text fallback is what is exercised.
      "job-2": { clean_text: "Design product flows.", sections: [], captured_at: null },
    } as Record<string, unknown>,
    companies: {
      "contoso.test": {
        displayed_name: "Contoso",
        domain: "contoso.test",
        company_profiles: {
          headquarters_country: "India",
          operating_countries: ["India", "United States"],
          industry: "Software",
          founded_year: 2015,
          employee_size_range: "51-200",
          public_private_status: "Private",
        },
      },
    } as Record<string, unknown>,
    insertedReports: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("../lib/supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "token" } } }),
      getUser: async () => ({ data: { user: { id: "candidate-1" } } }),
    },
    from: (table: string) => {
      const builder: any = {};
      let ids: string[] = [];
      let vacancyId: string | null = null;
      let domain: string | null = null;

      builder.select = () => builder;
      builder.in = (_column: string, values: string[]) => {
        ids = values;
        return builder;
      };
      builder.eq = (column: string, value: string) => {
        if (column === "vacancy_id") vacancyId = value;
        if (column === "domain") domain = value;
        return builder;
      };
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = async () => {
        if (table === "vacancy_jd_snapshots") {
          return { data: vacancyId === null ? null : fixtures.snapshots[vacancyId] ?? null, error: null };
        }
        if (table === "companies") {
          return { data: domain === null ? null : fixtures.companies[domain] ?? null, error: null };
        }
        return { data: null, error: null };
      };
      builder.insert = async (row: Record<string, unknown>) => {
        if (table === "vacancy_reports") {
          fixtures.insertedReports.push(row);
          return { error: null };
        }
        return { error: { message: "unexpected insert" } };
      };
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

const BULK_APPLY_BODY = {
  requested: 1,
  queued: 1,
  blocked: 0,
  errors: 0,
  outcomes: [{ vacancyId: "job-1", status: "queued", blockingGates: [] }],
};

beforeEach(() => {
  fixtures.insertedReports.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: unknown) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/api/opportunities/bulk-apply") ? BULK_APPLY_BODY : {}),
      text: async () => "",
    })),
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
    expect(screen.queryByText("Product Designer")).toBeNull();
  });

  it("renders the captured description as sections when the extractor found headings", async () => {
    renderAt("/jobs/job-1");

    expect(await screen.findByText("Responsibilities")).toBeTruthy();
    expect(screen.getByText("Build pipelines.")).toBeTruthy();
    expect(screen.getByText("Requirements")).toBeTruthy();
    expect(screen.getByText("Five years of Azure.")).toBeTruthy();
  });

  it("falls back to the full description when there are no section headings", async () => {
    renderAt("/jobs/job-2");

    expect(await screen.findByText("Design product flows.")).toBeTruthy();
  });

  it("shows the verified company context", async () => {
    renderAt("/jobs/job-1");

    expect(await screen.findByText("Software")).toBeTruthy();
    expect(screen.getByText("51-200")).toBeTruthy();
    expect(screen.getByText("2015")).toBeTruthy();
    expect(screen.getByText("India, United States")).toBeTruthy();
  });

  it("names why the job matches and what is missing", async () => {
    renderAt("/jobs/job-1");

    expect(await screen.findByText("Why this matches")).toBeTruthy();
    expect(screen.getByText("Strong Azure data platform overlap")).toBeTruthy();
    expect(screen.getByText("Potential gaps:")).toBeTruthy();
    expect(screen.getByText("Kubernetes")).toBeTruthy();
  });

  it("labels missing information as Not provided by source", async () => {
    renderAt("/jobs/job-3");

    expect(await screen.findByText("Mystery Role")).toBeTruthy();
    expect(screen.getAllByText("Not provided by source").length).toBeGreaterThan(0);
    expect(screen.getByText(/no verified company facts/i)).toBeTruthy();
  });

  it("keeps the outbound link on the detail page, pointing at the original URL", async () => {
    renderAt("/jobs/job-1");

    const link = await screen.findByRole("link", { name: /Open original job posting/ });
    expect(link.getAttribute("href")).toBe("https://source.test/job-1");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("queues the listing and reports the outcome", async () => {
    renderAt("/jobs/job-1");

    fireEvent.click(await screen.findByRole("button", { name: "Add to review queue" }));

    expect(await screen.findByText(/Successfully queued 1 application/)).toBeTruthy();
  });

  it("submits a report with the chosen category and confirms it", async () => {
    renderAt("/jobs/job-1");

    fireEvent.click(await screen.findByRole("button", { name: "Report this listing" }));
    fireEvent.change(screen.getByLabelText("What is wrong with this listing?"), {
      target: { value: "expired_job" },
    });
    fireEvent.change(screen.getByLabelText(/Anything else we should know/), {
      target: { value: "Still open." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText(/your report has been recorded/i)).toBeTruthy();
    expect(fixtures.insertedReports).toEqual([
      {
        vacancy_id: "job-1",
        reporter_id: "candidate-1",
        category: "expired_job",
        description: "Still open.",
      },
    ]);
  });

  it("reports a missing listing instead of rendering an empty page", async () => {
    renderAt("/jobs/does-not-exist");

    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
  });
});
