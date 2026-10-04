import { describe, expect, it } from "vitest";
import { isTrustworthyAcceptanceEvidence, pipelineStageOf } from "../../../shared/pipelineStages";

/**
 * The cross-surface agreement cases.
 *
 * Applications (client/src/lib/applications.ts), MCP (server/mcp/tools.ts) and
 * the feed (client/src/lib/opportunities.ts) all classify through
 * shared/pipelineStages.ts. These tests drive that shared contract with the
 * exact evidence shapes the loaders produce, which is the only place a silent
 * divergence between them could hide.
 *
 * MOCKED, NOT DATABASE-VALIDATED: nothing here executes the view, its lateral or
 * application_evidence RLS.
 */

const CONFIRMATION = {
  evidence_type: "submission_confirmation",
  payload: { adapterEvidenceType: "confirmation_id", confirmationId: "c1" },
};

describe("isTrustworthyAcceptanceEvidence", () => {
  it("accepts the canonical confirmation", () => {
    expect(isTrustworthyAcceptanceEvidence(CONFIRMATION)).toBe(true);
  });

  it("rejects anything that is not the canonical type or carries no confirming payload", () => {
    expect(isTrustworthyAcceptanceEvidence({ ...CONFIRMATION, evidence_type: "submission_error" })).toBe(false);
    expect(isTrustworthyAcceptanceEvidence({ ...CONFIRMATION, payload: null })).toBe(false);
    expect(isTrustworthyAcceptanceEvidence({ ...CONFIRMATION, payload: [] })).toBe(false);
    expect(isTrustworthyAcceptanceEvidence({ ...CONFIRMATION, payload: {} })).toBe(false);
    // Provenance alone is the wrapper, not the adapter's confirmation.
    expect(isTrustworthyAcceptanceEvidence({ ...CONFIRMATION, payload: { adapterEvidenceType: "x" } })).toBe(false);
    expect(isTrustworthyAcceptanceEvidence(null)).toBe(false);
  });
});

describe("pipelineStageOf agreements", () => {
  const eligible = true;

  it("older attempt confirmed does NOT validate the newer bare succeeded attempt", () => {
    // The plan's history: an older attempt was accepted, a LATER attempt is bare.
    // The later attempt is what the plan's current state is, and it has no
    // receipt of its own.
    expect(
      pipelineStageOf({
        attempts: [
          { status: "succeeded", acceptedEvidence: true },
          { status: "succeeded", acceptedEvidence: false },
        ],
        responseCategories: [],
        eligible,
      }),
    ).toBe("applied");

    // ...and when ONLY the newer, unevidenced attempt exists, it is not Applied.
    expect(
      pipelineStageOf({
        attempts: [{ status: "succeeded", acceptedEvidence: false }],
        responseCategories: [],
        eligible,
      }),
    ).toBe("needs_verification");
  });

  it("confirmed finalized success is Applied", () => {
    expect(
      pipelineStageOf({
        attempts: [{ status: "succeeded", acceptedEvidence: true }],
        responseCategories: [],
        eligible,
      }),
    ).toBe("applied");
  });

  it("submitting with a confirmation is reconciliation pending; without one it needs verification", () => {
    expect(
      pipelineStageOf({
        attempts: [{ status: "submitting", acceptedEvidence: true }],
        responseCategories: [],
        eligible,
      }),
    ).toBe("reconciliation_pending");

    expect(
      pipelineStageOf({
        attempts: [{ status: "submitting", acceptedEvidence: false }],
        responseCategories: [],
        eligible,
      }),
    ).toBe("needs_verification");

    // An unresolved submission is never reported as never-submitted either.
    expect(
      pipelineStageOf({
        attempts: [{ status: "submitting" }],
        responseCategories: [],
        eligible,
      }),
    ).toBe("needs_verification");
  });

  it("a response still outranks a bare succeeded attempt", () => {
    expect(
      pipelineStageOf({
        attempts: [{ status: "succeeded", acceptedEvidence: false }],
        responseCategories: ["interview"],
        eligible,
      }),
    ).toBe("interview");
  });
});
