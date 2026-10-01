import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessInput } from "../../shared/readiness.js";
import { loadCandidateReadiness, setupRefusals } from "./readinessGate.js";

/**
 * The server gate. These assert the two properties that matter: setup blockers
 * refuse a queue request, and capability blockers do NOT (they are already
 * enforced per-vacancy, and a blanket refusal would replace the useful per-job
 * reasons with one error).
 */

const COMPLETE: ReadinessInput = {
  resume: { status: "parsed" },
  targetRoleCount: 1,
  preferences: { saved: true, remotePreference: "remote", countryCount: 1, cityCount: 0, openToAnyLocation: false },
  consentStatus: "authorized",
  canQueue: true,
  planEntitled: true,
  reviewBeforeSubmit: true,
  scheduledAutomationRunning: false,
};

describe("setupRefusals", () => {
  it("allows a fully set-up candidate", () => {
    expect(setupRefusals(evaluateReadiness(COMPLETE))).toEqual([]);
  });

  it("refuses an uploaded-but-unparsed resume with a structured code", () => {
    const refusals = setupRefusals(evaluateReadiness({ ...COMPLETE, resume: { status: "uploaded" } }));

    expect(refusals.map((r) => r.code)).toContain("resume_missing");
    expect(refusals[0].message.length).toBeGreaterThan(0);
  });

  it("refuses a resume still parsing", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, resume: { status: "parsing" } })).map((r) => r.code)).toContain(
      "resume_parsing",
    );
  });

  it("refuses a resume whose parsing failed", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, resume: { status: "failed" } })).map((r) => r.code)).toContain(
      "resume_parse_failed",
    );
  });

  it("refuses when no target role is selected", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, targetRoleCount: 0 })).map((r) => r.code)).toContain(
      "target_roles_missing",
    );
  });

  it("refuses when search preferences were never saved", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, preferences: null })).map((r) => r.code)).toContain(
      "search_preferences_incomplete",
    );
  });

  it("refuses when consent is missing", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, consentStatus: null })).map((r) => r.code)).toContain(
      "submission_consent_missing",
    );
  });

  it("refuses when consent was stopped", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, consentStatus: "stopped" })).map((r) => r.code)).toContain(
      "automation_stopped",
    );
  });

  /**
   * The distinction that keeps existing behaviour intact: "no source can queue"
   * is not a setup refusal, so the per-vacancy eligibility reasons still reach
   * the candidate instead of one blanket error.
   */
  it("does not refuse for a missing supported source", () => {
    const readiness = evaluateReadiness({ ...COMPLETE, canQueue: false });

    expect(readiness.blockers.map((b) => b.code)).toContain("supported_source_missing");
    expect(setupRefusals(readiness)).toEqual([]);
  });

  it("fails closed on a malformed consent value", () => {
    expect(setupRefusals(evaluateReadiness({ ...COMPLETE, consentStatus: "approved" })).map((r) => r.code)).toContain(
      "submission_consent_missing",
    );
  });
});

describe("loadCandidateReadiness", () => {
  /**
   * A query failure must not read as readiness: the whole point of the gate is
   * that a database problem cannot be mistaken for the candidate having
   * completed a step.
   */
  it("reports an incomplete setup when every read fails", async () => {
    const client = {
      from: () => {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;

        for (const method of ["select", "eq", "order", "limit"]) {
          builder[method] = chain;
        }

        builder.maybeSingle = () => Promise.resolve({ data: null, error: { message: "down" } });
        builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { message: "down" }, count: null });

        return builder;
      },
    } as never;

    const readiness = await loadCandidateReadiness(client, "candidate-1");

    expect(readiness.setupComplete).toBe(false);
    expect(readiness.primaryState).toBe("setup_incomplete");
    expect(setupRefusals(readiness).length).toBeGreaterThan(0);
  });
});

describe("plan entitlement and setupRefusals", () => {
  it("does not refuse the request for a plan that excludes automation", () => {
    const readiness = evaluateReadiness({ ...COMPLETE, planEntitled: false });

    expect(readiness.blockers.map((b) => b.code)).toContain("plan_not_eligible");
    expect(setupRefusals(readiness)).toEqual([]);
  });
});
