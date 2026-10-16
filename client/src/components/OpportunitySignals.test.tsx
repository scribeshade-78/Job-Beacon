import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FitSection } from "./OpportunitySignals";
import type { OpportunityFitAnalysis } from "../lib/opportunities";

/**
 * The fit block is the ONLY place a candidate is told why a listing scored as it did. The
 * model produces six per-dimension rationales and a list of risks, and this asserts they
 * reach the DOM rather than being computed, paid for, and discarded.
 */

afterEach(cleanup);

function fit(over: Partial<OpportunityFitAnalysis> = {}): OpportunityFitAnalysis {
  return {
    priority: { score: 75, uncappedScore: 75, capped: false, version: "priority-v3", components: {} as never },
    technicalFitScore: 88,
    practicalEligibilityScore: 100,
    eligibilityCapped: false,
    hardBlockers: [],
    missingEvidence: ["SQL", "DOMO"],
    topReasons: ["Core stack overlap: Python, Snowflake, dbt and Airflow."],
    jdTextAvailable: true,
    risks: [],
    technicalFitComponents: null,
    ...over,
  };
}

const COMPONENTS = [
  { key: "core_technical_skills", score: 88, rationale: "All four JD technologies appear in the facts." },
  { key: "scale_performance_evidence", score: 90, rationale: "migrated 40 TB of warehouse tables." },
  { key: "domain", score: 86, rationale: "analytics-supporting data platforms and BI." },
];

describe("FitSection", () => {
  it("shows the scores, the reasons and the gaps", () => {
    render(<FitSection fit={fit()} />);

    expect(screen.getByText("Priority 75")).toBeTruthy();
    expect(screen.getByText(/Technical fit 88/)).toBeTruthy();
    expect(screen.getByText("Core stack overlap: Python, Snowflake, dbt and Airflow.")).toBeTruthy();
    expect(screen.getByText("SQL")).toBeTruthy();
  });

  it("renders each dimension's rationale on the detail surface", () => {
    render(<FitSection fit={fit({ technicalFitComponents: COMPONENTS })} variant="detail" />);

    // Human labels, not the raw keys: core_technical_skills is an internal identifier.
    expect(screen.getByText("Core technical skills")).toBeTruthy();
    expect(screen.getByText("Scale and performance")).toBeTruthy();
    expect(screen.getByText("Domain")).toBeTruthy();

    expect(screen.getByText("All four JD technologies appear in the facts.")).toBeTruthy();
    expect(screen.getByText("migrated 40 TB of warehouse tables.")).toBeTruthy();
  });

  it("does NOT put the breakdown on a card, where six rationales would bury the list", () => {
    render(<FitSection fit={fit({ technicalFitComponents: COMPONENTS })} />);

    expect(screen.queryByText("All four JD technologies appear in the facts.")).toBeNull();
  });

  it("renders the risks the model raised, on both surfaces", () => {
    // A risk is a "should I apply to this" signal, so it belongs on the card as well as the
    // detail page - unlike the breakdown, which is reference material.
    const risks = ["JD specifies a 2:00 PM-11:00 PM IST shift.", "SQL is central but not listed in the facts."];

    const { unmount } = render(<FitSection fit={fit({ risks })} />);
    expect(screen.getByText(risks[0])).toBeTruthy();
    expect(screen.getByText(risks[1])).toBeTruthy();
    unmount();

    render(<FitSection fit={fit({ risks })} variant="detail" />);
    expect(screen.getByText(risks[0])).toBeTruthy();
  });

  it("still reports an ineligible listing, and shows no breakdown it does not have", () => {
    render(
      <FitSection
        variant="detail"
        fit={fit({
          eligibilityCapped: true,
          practicalEligibilityScore: 0,
          priority: { score: 0, uncappedScore: 35, capped: true, version: "priority-v3", components: {} as never },
          hardBlockers: [{ code: "LOCATION_PRESENCE", detail: "Non-remote role in a country the candidate is not located in." }],
        })}
      />,
    );

    expect(screen.getByText("Not eligible")).toBeTruthy();
    expect(screen.getByText(/Not eligible\./)).toBeTruthy();
    expect(screen.getByText(/would rank 35 if eligible/)).toBeTruthy();
  });

  it("says the analysis is pending rather than showing an empty block", () => {
    render(<FitSection fit={null} />);
    expect(screen.getByText("Fit analysis pending")).toBeTruthy();
  });
});
