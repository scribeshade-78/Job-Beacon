import { describe, expect, it } from "vitest";
import {
  evaluateReadiness,
  locationIntentExplicit,
  preferencesStepComplete,
  readinessHeadline,
  resumeStepComplete,
  resumeStepDetail,
  workModeExplicit,
  type ReadinessInput,
} from "./readiness.js";

/**
 * Fixtures are built through one helper so a test states only the input it is
 * about, and every other input sits in a known-good state — otherwise a passing
 * test could be passing for the wrong reason.
 */
const COMPLETE_RESUME = { status: "parsed" };
const COMPLETE_PREFERENCES = {
  saved: true,
  remotePreference: "remote",
  countryCount: 1,
  cityCount: 0,
  openToAnyLocation: false,
};

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    resume: COMPLETE_RESUME,
    targetRoleCount: 2,
    preferences: COMPLETE_PREFERENCES,
    consentStatus: "authorized",
    canQueue: true,
    planEntitled: true,
    reviewBeforeSubmit: true,
    scheduledAutomationRunning: false,
    ...overrides,
  };
}

describe("resume readiness", () => {
  it("is not ready with no document at all", () => {
    expect(resumeStepComplete(null)).toBe(false);
    expect(resumeStepDetail(null)).toBe("Upload a resume");
  });

  it("is not ready merely because a document was uploaded", () => {
    // THE ORIGINAL BUG, at the unit level: a resume row existing is not parsing.
    expect(resumeStepComplete({ status: "uploaded" })).toBe(false);
    expect(resumeStepDetail({ status: "uploaded" })).toBe("Resume uploaded · Waiting to be processed");
  });

  it("is not ready while parsing is in progress", () => {
    expect(resumeStepComplete({ status: "parsing" })).toBe(false);
    expect(resumeStepDetail({ status: "parsing" })).toBe("Resume parsing in progress");
  });

  it("is not ready when parsing failed", () => {
    expect(resumeStepComplete({ status: "failed" })).toBe(false);
    expect(resumeStepDetail({ status: "failed" })).toBe("Resume parsing failed · Review or retry");
  });

  it("is ready only when parsing succeeded", () => {
    expect(resumeStepComplete({ status: "parsed" })).toBe(true);
  });

  it("fails closed on an unknown or malformed status", () => {
    for (const status of ["PARSED", "complete", "", null, undefined, 42, {}, []]) {
      expect(resumeStepComplete({ status })).toBe(false);
      expect(resumeStepDetail({ status })).toBe("Resume uploaded · Waiting to be processed");
    }
  });
});

describe("target role readiness", () => {
  it("is not ready with no roles and blocks with target_roles_missing", () => {
    const readiness = evaluateReadiness(input({ targetRoleCount: 0 }));

    expect(readiness.rolesReady).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).toContain("target_roles_missing");
  });

  it("is ready with at least one role", () => {
    expect(evaluateReadiness(input({ targetRoleCount: 1 })).rolesReady).toBe(true);
  });
});

describe("preference readiness", () => {
  it("is not ready when no preferences row was ever saved", () => {
    expect(preferencesStepComplete(null)).toBe(false);
    expect(evaluateReadiness(input({ preferences: null })).preferencesReady).toBe(false);
  });

  it("is not ready when the row exists but location intent is absent", () => {
    const preferences = { ...COMPLETE_PREFERENCES, countryCount: 0, cityCount: 0, openToAnyLocation: false };

    expect(locationIntentExplicit(preferences)).toBe(false);
    expect(preferencesStepComplete(preferences)).toBe(false);
  });

  it("is ready with one country selected", () => {
    expect(locationIntentExplicit({ ...COMPLETE_PREFERENCES, countryCount: 1 })).toBe(true);
  });

  it("is ready with one city selected", () => {
    expect(locationIntentExplicit({ ...COMPLETE_PREFERENCES, cityCount: 1 })).toBe(true);
  });

  it("is ready when open to any location is explicitly true", () => {
    const preferences = { ...COMPLETE_PREFERENCES, countryCount: 0, cityCount: 0, openToAnyLocation: true };

    expect(locationIntentExplicit(preferences)).toBe(true);
    expect(preferencesStepComplete(preferences)).toBe(true);
  });

  it("treats a non-boolean open-to-any value as not stated", () => {
    const preferences = { ...COMPLETE_PREFERENCES, countryCount: 0, cityCount: 0, openToAnyLocation: "true" };

    expect(locationIntentExplicit(preferences as never)).toBe(false);
  });

  it("is not ready when work mode was never stated", () => {
    expect(workModeExplicit({ ...COMPLETE_PREFERENCES, remotePreference: null })).toBe(false);
    expect(preferencesStepComplete({ ...COMPLETE_PREFERENCES, remotePreference: null })).toBe(false);
  });

  it("accepts every explicit work mode the column allows, including any", () => {
    for (const remotePreference of ["remote", "hybrid", "on_site", "any"]) {
      expect(workModeExplicit({ ...COMPLETE_PREFERENCES, remotePreference })).toBe(true);
    }
  });

  it("rejects a work mode the column does not allow", () => {
    expect(workModeExplicit({ ...COMPLETE_PREFERENCES, remotePreference: "flexible" })).toBe(false);
  });

  /**
   * The two axes are independent: 'any' work mode says nothing about geography.
   * Treating it as "anywhere" would silently widen a candidate's search.
   */
  it("does not treat remote_preference = any as any location", () => {
    const preferences = {
      ...COMPLETE_PREFERENCES,
      remotePreference: "any",
      countryCount: 0,
      cityCount: 0,
      openToAnyLocation: false,
    };

    expect(locationIntentExplicit(preferences)).toBe(false);
    expect(preferencesStepComplete(preferences)).toBe(false);
  });

  it("is complete with remote_preference = any plus open_to_any_location", () => {
    const preferences = {
      ...COMPLETE_PREFERENCES,
      remotePreference: "any",
      countryCount: 0,
      cityCount: 0,
      openToAnyLocation: true,
    };

    expect(preferencesStepComplete(preferences)).toBe(true);
  });

  /**
   * Enabling the flag must not discard the stored locations: they are what makes
   * turning it back off restore the previous scope.
   */
  it("keeps retained locations usable when open-to-any is switched back off", () => {
    const on = { ...COMPLETE_PREFERENCES, countryCount: 3, openToAnyLocation: true };
    const off = { ...COMPLETE_PREFERENCES, countryCount: 3, openToAnyLocation: false };

    expect(locationIntentExplicit(on)).toBe(true);
    expect(locationIntentExplicit(off)).toBe(true);
  });
});

describe("consent readiness and primary state precedence", () => {
  it("reports missing consent when no row exists", () => {
    const readiness = evaluateReadiness(input({ consentStatus: null }));

    expect(readiness.consentReady).toBe(false);
    expect(readiness.primaryState).toBe("submission_consent_missing");
  });

  it("fails closed on an unrecognised consent status", () => {
    for (const consentStatus of ["approved", "ACTIVE", 1, {}]) {
      const readiness = evaluateReadiness(input({ consentStatus }));

      expect(readiness.consentReady).toBe(false);
      expect(readiness.primaryState).toBe("submission_consent_missing");
    }
  });

  it("counts consent as granted but not as ready-for-submission when paused", () => {
    const readiness = evaluateReadiness(input({ consentStatus: "paused" }));

    expect(readiness.primaryState).toBe("automation_paused");
    expect(readiness.consentReady).toBe(false);
    expect(readiness.submissionAvailable).toBe(false);
  });

  it("reports stopped for a stopped consent", () => {
    expect(evaluateReadiness(input({ consentStatus: "stopped" })).primaryState).toBe("stopped");
  });

  /**
   * THE RULE THAT MAKES THE PAUSED/STOPPED OVERRIDE SAFE. A candidate who paused
   * and is also missing a resume must be told about the resume, not about pause.
   */
  it("does not let paused consent hide an incomplete setup", () => {
    for (const consentStatus of ["paused", "stopped"]) {
      const readiness = evaluateReadiness(input({ resume: null, consentStatus }));

      expect(readiness.primaryState).toBe("setup_incomplete");
      expect(readiness.blockers.map((b) => b.code)).toContain("resume_missing");
    }
  });

  it("does not let stopped consent imply roles or preferences are ready", () => {
    const readiness = evaluateReadiness(
      input({ targetRoleCount: 0, preferences: null, consentStatus: "stopped" }),
    );

    expect(readiness.primaryState).toBe("setup_incomplete");
    const codes = readiness.blockers.map((b) => b.code);
    expect(codes).toContain("target_roles_missing");
    expect(codes).toContain("search_preferences_incomplete");
  });

  it("reports setup_incomplete with a count of completed steps", () => {
    const readiness = evaluateReadiness(input({ resume: null, targetRoleCount: 0 }));

    expect(readiness.primaryState).toBe("setup_incomplete");
    expect(readiness.completedSteps).toBe(2);
    expect(readiness.totalSteps).toBe(4);
    expect(readinessHeadline(readiness)).toBe("Setup incomplete · 2 of 4 complete");
  });

  it("shows 3 of 4 when only consent is missing", () => {
    const readiness = evaluateReadiness(input({ consentStatus: null }));

    expect(readiness.completedSteps).toBe(3);
    expect(readinessHeadline(readiness)).toBe("Ready to search · Submission consent required");
  });

  /**
   * THE CURRENT PRODUCTION SHAPE: everything the candidate can do is done, and
   * the product still cannot submit for anybody. It must say so rather than
   * showing a capability that does not exist.
   */
  it("reports blocked_no_supported_source when setup is complete but nothing can queue", () => {
    const readiness = evaluateReadiness(input({ canQueue: false }));

    expect(readiness.setupComplete).toBe(true);
    expect(readiness.primaryState).toBe("blocked_no_supported_source");
    expect(readinessHeadline(readiness)).toBe("Setup complete · Automatic submission unavailable");
    expect(readiness.blockers.map((b) => b.code)).toContain("supported_source_missing");
    expect(readiness.submissionAvailable).toBe(false);
    expect(readiness.automationControlsAvailable).toBe(false);
  });

  it("does not report a capability blocker while a setup step is still missing", () => {
    const readiness = evaluateReadiness(input({ canQueue: false, resume: null }));

    expect(readiness.blockers.map((b) => b.code)).not.toContain("supported_source_missing");
  });

  it("reports ready_for_review_queue when everything is in place", () => {
    const readiness = evaluateReadiness(input());

    expect(readiness.primaryState).toBe("ready_for_review_queue");
    expect(readinessHeadline(readiness)).toBe("Ready for application review");
    expect(readiness.reviewQueueAvailable).toBe(true);
    expect(readiness.automationControlsAvailable).toBe(true);
  });

  /**
   * 'active' requires a genuinely running process, which no code currently
   * provides — so an authorized, capable, fully set-up candidate is NOT active.
   */
  it("does not report active merely because consent is authorized", () => {
    expect(evaluateReadiness(input()).primaryState).not.toBe("active");
  });

  it("reports active only when a scheduled process is genuinely running", () => {
    const readiness = evaluateReadiness(input({ scheduledAutomationRunning: true }));

    expect(readiness.primaryState).toBe("active");
    expect(readinessHeadline(readiness)).toBe("Automation active");
  });

  it("exposes discovery availability without implying submission permission", () => {
    const readiness = evaluateReadiness(input({ resume: null, canQueue: false }));

    expect(readiness.discoveryAvailable).toBe(true);
    expect(readiness.submissionAvailable).toBe(false);
    expect(readiness.primaryState).toBe("setup_incomplete");
  });

  it("every blocker carries a code, a human message and no schema language", () => {
    const readiness = evaluateReadiness(
      input({ resume: null, targetRoleCount: 0, preferences: null, consentStatus: null, canQueue: false }),
    );

    expect(readiness.blockers.length).toBeGreaterThan(0);

    for (const blocker of readiness.blockers) {
      expect(blocker.code).toMatch(/^[a-z_]+$/);
      expect(blocker.message.length).toBeGreaterThan(0);
      expect(blocker.message.toLowerCase()).not.toMatch(/public\.|_id|column|table|sql|null/);
    }
  });

  it("lists four steps and derives the completed count from them", () => {
    const readiness = evaluateReadiness(input());

    expect(readiness.steps.map((step) => step.id)).toEqual([
      "resume",
      "target_roles",
      "search_preferences",
      "submission_consent",
    ]);
    expect(readiness.steps.every((step) => step.complete)).toBe(true);
    expect(readiness.completedSteps).toBe(4);
  });
});

describe("plan entitlement readiness", () => {
  it("reports plan_not_eligible, and refuses the queue, when the plan excludes automation", () => {
    const readiness = evaluateReadiness(input({ planEntitled: false }));

    expect(readiness.setupComplete).toBe(true);
    expect(readiness.blockers.map((b) => b.code)).toContain("plan_not_eligible");
    expect(readiness.primaryState).toBe("plan_not_eligible");
    expect(readiness.reviewQueueAvailable).toBe(false);
    expect(readiness.submissionAvailable).toBe(false);
    expect(readinessHeadline(readiness)).toBe("Setup complete · Your plan does not include automation");
  });

  it("does not report the plan blocker before the four setup steps are complete", () => {
    const readiness = evaluateReadiness(input({ planEntitled: false, resume: { status: "uploaded" } }));

    expect(readiness.blockers.map((b) => b.code)).not.toContain("plan_not_eligible");
    expect(readiness.primaryState).toBe("setup_incomplete");
  });

  it("is ready for the review queue with a complete setup, consent and an entitled plan", () => {
    const readiness = evaluateReadiness(input({ planEntitled: true }));

    expect(readiness.blockers.map((b) => b.code)).not.toContain("plan_not_eligible");
    expect(readiness.primaryState).toBe("ready_for_review_queue");
    expect(readiness.reviewQueueAvailable).toBe(true);
  });
});
