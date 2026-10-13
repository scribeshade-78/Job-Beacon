import { describe, expect, it } from "vitest";
import { decideFillClaim, decideSubmissionGrant, type ClaimContext } from "./claimDecision.js";
import type { EligibilityGates, GateResult } from "./eligibilityGate.js";

const pass: GateResult = { status: "pass" };
const fail = (reasonCode: string): GateResult => ({ status: "fail", reasonCode });

/** Every gate present and passing; individual cases spoil exactly one. */
function gates(overrides: Partial<EligibilityGates> = {}): EligibilityGates {
  return {
    source_policy: pass,
    vacancy_trust: pass,
    automation_authorization: pass,
    candidate_exclusions: pass,
    idempotency: pass,
    role_match: pass,
    verified_facts: pass,
    application_support: pass,
    rate_and_abuse_controls: pass,
    dismissed: pass,
    preferred_qualifiers: pass,
    ...overrides,
  };
}

/** A copy with optional gates removed, without `delete` on a cast expression. */
function withoutOptional(source: EligibilityGates, keys: string[]): EligibilityGates {
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) {
    delete copy[key];
  }
  return copy as unknown as EligibilityGates;
}

function context(overrides: Partial<ClaimContext> = {}): ClaimContext {
  return { gates: gates(), reviewBeforeSubmit: false, attemptStatus: "pending", ...overrides };
}

describe("decideFillClaim", () => {
  it("allows a fill when every gate passes and the attempt is not held for review", () => {
    expect(decideFillClaim(context())).toEqual({ allowed: true });
  });

  it("REFUSES when any single gate fails, and names which", () => {
    // Every gate, one at a time. A claim loop that checked a subset would pass the happy
    // path and authorise a submission the platform had already refused.
    const names = Object.keys(gates());
    expect(names.length).toBeGreaterThanOrEqual(11);
    for (const name of names) {
      const spoiled: Record<string, GateResult> = { ...gates(), [name]: fail("GATE_FAILED") };
      const outcome = decideFillClaim(context({ gates: spoiled as unknown as EligibilityGates }));
      expect(outcome.allowed, name + " must be enforced").toBe(false);
      if (!outcome.allowed) {
        expect(outcome.gate, name + " must be named").toBe(name);
        expect(outcome.reasonCode).toBe("GATE_FAILED");
      }
    }
  });

  it("refuses an optional gate that is PRESENT and failing", () => {
    const outcome = decideFillClaim(context({ gates: gates({ plan_entitlement: fail("QUOTA_EXHAUSTED") }) }));
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reasonCode).toBe("QUOTA_EXHAUSTED");
  });

  it("treats an ABSENT optional gate as not-failing, not as a pass we invented", () => {
    const sparse = withoutOptional(gates(), ["excluded_company", "excluded_industry", "work_mode", "salary", "location", "plan_entitlement"]);
    expect(decideFillClaim(context({ gates: sparse })).allowed).toBe(true);
  });

  it("allows a fill for an attempt HELD FOR REVIEW - the fill is what review is for", () => {
    expect(decideFillClaim(context({ attemptStatus: "pending_review" })).allowed).toBe(true);
  });

  it("refuses an attempt another worker already holds", () => {
    const outcome = decideFillClaim(context({ attemptStatus: "leased" }));
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.refusal).toBe("ALREADY_CLAIMED");
  });

  it("refuses an attempt with nothing left to do", () => {
    const done = ["succeeded", "submitting", "cancelled"];
    for (const status of done) {
      const outcome = decideFillClaim(context({ attemptStatus: status }));
      expect(outcome.allowed, status).toBe(false);
    }
  });

  it("NEVER returns a token - the fill trip cannot authorise a submission", () => {
    const outcome = decideFillClaim(context());
    expect(JSON.stringify(outcome)).not.toMatch(/token/i);
  });
});

describe("decideSubmissionGrant - the SECOND trip", () => {
  function approvedContext(overrides: Record<string, unknown> = {}) {
    return {
      gates: gates(),
      reviewBeforeSubmit: true,
      attemptStatus: "pending_review",
      candidateApproved: true,
      holdsLease: true,
      ...overrides,
    } as Parameters<typeof decideSubmissionGrant>[0];
  }

  it("grants only when the candidate explicitly approved on this attempt", () => {
    expect(decideSubmissionGrant(approvedContext())).toEqual({ allowed: true });
  });

  it("REFUSES without explicit approval, however healthy everything else is", () => {
    // The whole point of the second round trip. A fill payload must never be enough.
    const outcome = decideSubmissionGrant(approvedContext({ candidateApproved: false }));
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.refusal).toBe("NOT_APPROVED");
  });

  it("REFUSES when the caller does not hold the lease - another tab, another attempt", () => {
    const outcome = decideSubmissionGrant(approvedContext({ holdsLease: false }));
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.refusal).toBe("LEASE_LOST");
  });

  it("RE-RUNS every gate at submission time, so a change since the fill is caught", () => {
    for (const name of Object.keys(gates())) {
      const spoiled: Record<string, GateResult> = { ...gates(), [name]: fail("CHANGED") };
      const outcome = decideSubmissionGrant(approvedContext({ gates: spoiled as unknown as EligibilityGates }));
      expect(outcome.allowed, name + " must be re-checked at submit time").toBe(false);
    }
  });

  it("refuses an attempt no longer awaiting review - already submitted elsewhere", () => {
    for (const status of ["succeeded", "submitting", "cancelled", "failed", "leased"]) {
      const outcome = decideSubmissionGrant(approvedContext({ attemptStatus: status }));
      expect(outcome.allowed, status).toBe(false);
    }
  });

  it("accepts the state approval ACTUALLY leaves behind: review_approved_at set, status pending", () => {
    // attemptReview.ts approves by stamping review_approved_at and resetting the status to
    // 'pending'. Requiring 'pending_review' at submission time would have refused every
    // approved attempt - the flow would have looked wired and submitted nothing.
    const outcome = decideSubmissionGrant(
      approvedContext({ attemptStatus: "pending", reviewBeforeSubmit: true, candidateApproved: true }),
    );
    expect(outcome.allowed).toBe(true);
  });

  it("still refuses 'pending' when approval was NEVER given", () => {
    // The guard above must not become a way round the review gate.
    const outcome = decideSubmissionGrant(
      approvedContext({ attemptStatus: "pending", reviewBeforeSubmit: true, candidateApproved: false }),
    );
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.refusal).toBe("NOT_APPROVED");
  });

  it("allows submission from pending for a candidate who waived review", () => {
    const outcome = decideSubmissionGrant(approvedContext({ reviewBeforeSubmit: false, attemptStatus: "pending" }));
    expect(outcome.allowed).toBe(true);
  });
});
