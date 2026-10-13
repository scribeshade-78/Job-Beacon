import { describe, expect, it } from "vitest";
import { stageOf } from "./TrackerPage";
import type { ApplicationSummary } from "../lib/applications";
import type { ResponseCategory } from "../../../shared/priorityScore";

/**
 * THE MAPPING THAT DECIDES WHAT A CANDIDATE IS TOLD ABOUT THEIR APPLICATION.
 *
 * The one that matters is "submitting": it is the state an unverified extension report
 * leaves behind, and rendering it as "In progress" tells a candidate their application is
 * being worked on when the truth is that nobody knows whether it was ever sent.
 */
function application(opts: {
  statuses: string[];
  acceptedEvidence?: boolean;
  responseCategories?: ResponseCategory[];
  updatedAt?: string;
}): ApplicationSummary {
  return {
    planId: "plan-1",
    vacancyId: "vacancy-1",
    vacancyTitle: "Frontend Engineer",
    vacancyUrl: "https://example.test/job",
    companyName: "Northwind",
    eligible: true,
    ineligibleReason: null,
    createdAt: "2026-10-01T00:00:00Z",
    responseCategories: opts.responseCategories ?? [],
    attempts: opts.statuses.map((status, index) => ({
      id: "attempt-" + index,
      status,
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: opts.updatedAt ?? "2026-10-02T00:00:00Z",
      evidence: [],
      acceptedEvidence: opts.acceptedEvidence ?? false,
    })),
  } as unknown as ApplicationSummary;
}

describe("stageOf", () => {
  it("maps submitting to needs_verification, NOT to in_progress", () => {
    // The gap this test exists to close. "In progress" reads as "we are working on it";
    // the truth for a submitting attempt is "we do not know, and you should check".
    expect(stageOf(application({ statuses: ["submitting"] }))).toBe("needs_verification");
  });

  it("maps action_required to needs_verification - it is a request TO the candidate", () => {
    expect(stageOf(application({ statuses: ["action_required"] }))).toBe("needs_verification");
  });

  it("checks submitting BEFORE acceptedEvidence, so an unverified attempt cannot be laundered", () => {
    // Deliberately contradictory input: a receipt-backed flag ALONGSIDE a submitting
    // status. Ordering is the only thing that resolves it, and the cautious answer wins.
    expect(stageOf(application({ statuses: ["submitting"], acceptedEvidence: true }))).toBe("needs_verification");
  });

  it("maps a receipt-backed success to applied", () => {
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true }))).toBe("applied");
  });

  it("does NOT call a bare succeeded status applied - the status alone is a claim", () => {
    // acceptedEvidence is what makes an application "Applied"; a worker-written status
    // without a receipt is exactly the unchecked claim the evidence flag exists to catch.
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: false }))).toBe("in_progress");
  });

  it("maps cancelled to archived", () => {
    expect(stageOf(application({ statuses: ["cancelled"] }))).toBe("archived");
  });

  it("maps a still-pending attempt to in_progress", () => {
    for (const status of ["pending", "pending_review", "leased", "failed"]) {
      expect(stageOf(application({ statuses: [status] })), status).toBe("in_progress");
    }
  });

  it("lets a classified REPLY outrank the lifecycle status", () => {
    // A reply is the employer having acted; the lifecycle status only says what WE did.
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true, responseCategories: ["offer"] }))).toBe("offer");
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true, responseCategories: ["interview"] }))).toBe("interview");
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true, responseCategories: ["rejection"] }))).toBe("rejection");
  });

  it("treats a non-stage reply as a live application, not a rejection", () => {
    for (const category of ["action_required", "recruiter_followup", "application_received", "other"] as ResponseCategory[]) {
      expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true, responseCategories: [category] })), category).toBe("applied");
    }
  });

  it("takes the HIGHEST stage when an application has several replies", () => {
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true, responseCategories: ["rejection", "offer"] }))).toBe("offer");
    expect(stageOf(application({ statuses: ["succeeded"], acceptedEvidence: true, responseCategories: ["application_received", "interview"] }))).toBe("interview");
  });

  it("maps an application with NO attempts to in_progress rather than crashing", () => {
    expect(stageOf(application({ statuses: [] }))).toBe("in_progress");
  });
});
