import { describe, expect, it } from "vitest";
import {
  CATEGORIZED_STAGE_IDS,
  countByPipelineStage,
  filterByPipelineStage,
  matchesPipelineStage,
  pipelineStageOf,
  PIPELINE_STAGES,
} from "./pipelineStages";
import type { ApplicationSummary } from "./applications";
import type { ResponseCategory } from "../../../shared/priorityScore";
import { GENERIC_INELIGIBLE_REASON, ineligibilityReasonOf } from "../../../shared/eligibilityReason";

type AttemptStatus = "pending" | "leased" | "succeeded" | "failed" | "action_required" | "cancelled";

function application(
  statuses: AttemptStatus[],
  responseCategories: ResponseCategory[] = [],
  eligible = true,
): ApplicationSummary {
  return {
    planId: "plan-1",
    vacancyId: "vac-1",
    vacancyTitle: "Data Engineer",
    vacancyUrl: "https://example.test/job/1",
    companyName: null,
    eligible,
    ineligibleReason: null,
    createdAt: "2026-09-17T00:00:00Z",
    responseCategories,
    attempts: statuses.map((status, index) => ({
      id: "attempt-" + index,
      status,
      attempts: 1,
      maxAttempts: 5,
      lastError: null,
      createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:00:00Z",
      evidence: [],
    })),
  };
}

describe("PIPELINE_STAGES", () => {
  it("is ordered chronologically: All, In Progress, then the ascending stages", () => {
    expect(PIPELINE_STAGES.map((stage) => stage.id)).toEqual([
      "all",
      "in_progress",
      "ineligible",
      "applied",
      "interview",
      "offer",
      "rejection",
    ]);
  });

  it("places In Progress directly after the All aggregate", () => {
    // The entry state belongs next to All, not at the end as a catch-all.
    expect(PIPELINE_STAGES[1].id).toBe("in_progress");
  });

  it("keeps Verification and Assessment out", () => {
    const ids = PIPELINE_STAGES.map((stage) => String(stage.id));
    expect(ids).not.toContain("verification");
    expect(ids).not.toContain("assessment");
  });
});

describe("pipelineStageOf", () => {
  it("assigns Applied to a submitted application with no response", () => {
    expect(pipelineStageOf(application(["succeeded"]))).toBe("applied");
  });

  it("assigns each response stage to its own category", () => {
    expect(pipelineStageOf(application(["succeeded"], ["interview"]))).toBe("interview");
    expect(pipelineStageOf(application(["succeeded"], ["offer"]))).toBe("offer");
    expect(pipelineStageOf(application(["succeeded"], ["rejection"]))).toBe("rejection");
  });

  it("applies the precedence Offer > Rejection > Interview", () => {
    // The realistic case: interviewed, then rejected. Both categories are
    // present, and the terminal outcome is what the candidate has reached.
    expect(pipelineStageOf(application(["succeeded"], ["interview", "rejection"]))).toBe("rejection");
    expect(pipelineStageOf(application(["succeeded"], ["interview", "offer"]))).toBe("offer");
    expect(pipelineStageOf(application(["succeeded"], ["interview", "rejection", "offer"]))).toBe("offer");
    expect(pipelineStageOf(application(["succeeded"], ["rejection", "offer"]))).toBe("offer");
  });

  it("is order-independent — the precedence is in the rule, not the array", () => {
    expect(pipelineStageOf(application(["succeeded"], ["rejection", "interview"]))).toBe("rejection");
    expect(pipelineStageOf(application(["succeeded"], ["offer", "rejection", "interview"]))).toBe("offer");
  });

  it("puts an eligible, never-submitted application In Progress", () => {
    expect(pipelineStageOf(application(["pending"]))).toBe("in_progress");
    expect(pipelineStageOf(application(["leased"]))).toBe("in_progress");
    expect(pipelineStageOf(application([]))).toBe("in_progress");
    expect(pipelineStageOf(application(["cancelled"]))).toBe("in_progress");
  });

  it("sends a never-submitted, ineligible application to Not eligible", () => {
    // The bug this fixes: these rows used to be counted as In Progress even
    // though no attempt existed and none was ever going to.
    expect(pipelineStageOf(application([], [], false))).toBe("ineligible");
  });

  it("keeps a real submission out of the ineligible bucket", () => {
    // gate_results is re-evaluated and can flip to false after a plan was sent;
    // a succeeded attempt or a response is evidence something real happened.
    expect(pipelineStageOf(application(["succeeded"], [], false))).toBe("applied");
    expect(pipelineStageOf(application([], ["rejection"], false))).toBe("rejection");
  });

  it("NEVER treats a failed submission as a rejection", () => {
    // 'failed' means our worker could not send the application at all. Calling
    // that a rejection would tell a candidate they were turned down for a job
    // that was never applied to.
    expect(pipelineStageOf(application(["failed"]))).toBe("in_progress");
    expect(pipelineStageOf(application(["failed"]) )).not.toBe("rejection");
  });

  it("still reports a response stage for a failed submission that drew a reply", () => {
    // Contrived but total: the response is real regardless of how we got there.
    expect(pipelineStageOf(application(["failed"], ["rejection"]))).toBe("rejection");
  });

  it("ignores response categories with no stage of their own", () => {
    expect(pipelineStageOf(application(["succeeded"], ["recruiter_followup"]))).toBe("applied");
    expect(pipelineStageOf(application(["succeeded"], ["other"]))).toBe("applied");
  });
});

describe("mutual exclusivity", () => {
  const applications = [
    application(["succeeded"]),
    application(["succeeded"], ["interview"]),
    application(["succeeded"], ["interview", "rejection"]),
    application(["succeeded"], ["offer"]),
    application(["failed"]),
    application(["pending"]),
    application([]),
    application([], [], false),
  ];

  it("places every application in exactly one categorized stage", () => {
    for (const row of applications) {
      const matched = CATEGORIZED_STAGE_IDS.filter((stage) => matchesPipelineStage(row, stage));
      expect(matched).toHaveLength(1);
    }
  });

  it("never double-counts across the categorized stages", () => {
    const counts = countByPipelineStage(applications);
    const summed = CATEGORIZED_STAGE_IDS.reduce((total, stage) => total + counts[stage], 0);

    expect(summed).toBe(counts.all);
    expect(summed).toBe(applications.length);
  });

  it("keeps All matching everything, including rows in no visible stage otherwise", () => {
    for (const row of applications) {
      expect(matchesPipelineStage(row, "all")).toBe(true);
    }
  });
});

describe("countByPipelineStage", () => {
  it("sums the categorized counts exactly to All", () => {
    const counts = countByPipelineStage([
      application(["succeeded"]),
      application(["succeeded"]),
      application(["succeeded"], ["interview"]),
      application(["succeeded"], ["interview", "rejection"]),
      application(["succeeded"], ["offer"]),
      application(["failed"]),
      application(["pending"]),
    ]);

    expect(counts).toEqual({
      all: 7,
      applied: 2,
      interview: 1,
      offer: 1,
      rejection: 1,
      in_progress: 2,
      ineligible: 0,
    });
    expect(
      counts.applied +
        counts.interview +
        counts.offer +
        counts.rejection +
        counts.in_progress +
        counts.ineligible,
    ).toBe(counts.all);
  });

  it("counts zeros for an empty list", () => {
    expect(countByPipelineStage([])).toEqual({
      all: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      rejection: 0,
      in_progress: 0,
      ineligible: 0,
    });
  });

  it("sums exactly to All for a large mixed list", () => {
    const list = [
      ...Array.from({ length: 5 }, () => application(["succeeded"])),
      ...Array.from({ length: 3 }, () => application(["succeeded"], ["interview"])),
      ...Array.from({ length: 2 }, () => application(["succeeded"], ["offer"])),
      ...Array.from({ length: 4 }, () => application(["succeeded"], ["rejection"])),
      ...Array.from({ length: 6 }, () => application(["failed"])),
    ];

    const counts = countByPipelineStage(list);
    const summed = CATEGORIZED_STAGE_IDS.reduce((total, stage) => total + counts[stage], 0);

    expect(counts.all).toBe(20);
    expect(summed).toBe(20);
  });
});

describe("filterByPipelineStage", () => {
  const applications = [
    application(["succeeded"]),
    application(["succeeded"], ["interview"]),
    application(["succeeded"], ["offer"]),
    application(["failed"]),
  ];

  it("filters each stage to a disjoint set", () => {
    expect(filterByPipelineStage(applications, "applied")).toHaveLength(1);
    expect(filterByPipelineStage(applications, "interview")).toHaveLength(1);
    expect(filterByPipelineStage(applications, "offer")).toHaveLength(1);
    expect(filterByPipelineStage(applications, "in_progress")).toHaveLength(1);
    expect(filterByPipelineStage(applications, "rejection")).toHaveLength(0);
  });

  it("returns everything for All", () => {
    expect(filterByPipelineStage(applications, "all")).toHaveLength(4);
  });

  it("returns an empty list for a stage nothing reaches, without throwing", () => {
    expect(filterByPipelineStage([application(["pending"])], "offer")).toEqual([]);
  });
});

describe("ineligibilityReasonOf", () => {
  it("translates the first failing gate's reasonCode", () => {
    expect(
      ineligibilityReasonOf({
        application_support: { status: "fail", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" },
      }),
    ).toBe("automatic applications aren't available for this job's site yet");
  });

  it("draws from gate precedence when several gates fail", () => {
    expect(
      ineligibilityReasonOf({
        application_support: { status: "fail", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" },
        role_match: { status: "fail", reasonCode: "ROLE_NOT_MATCHED" },
      }),
    ).toBe("this job doesn't match the roles you selected");
  });

  it("falls back to a generic sentence rather than a raw token", () => {
    expect(ineligibilityReasonOf({ role_match: { status: "fail", reasonCode: "SOMETHING_NEW" } })).toBe(
      GENERIC_INELIGIBLE_REASON,
    );
    expect(ineligibilityReasonOf({ role_match: { status: "fail" } })).toBe(GENERIC_INELIGIBLE_REASON);
    expect(ineligibilityReasonOf(undefined)).toBe(GENERIC_INELIGIBLE_REASON);
  });

  it("ignores gates that passed", () => {
    expect(ineligibilityReasonOf({ role_match: { status: "pass" } })).toBe(GENERIC_INELIGIBLE_REASON);
  });
});
