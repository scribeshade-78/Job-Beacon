import { describe, expect, it } from "vitest";
import { describeApplicationEvidence, type ApplicationEvidenceRow } from "./applicationEvidence";

function row(overrides: Partial<ApplicationEvidenceRow> = {}): ApplicationEvidenceRow {
  return {
    id: "e1",
    evidence_type: "greenhouse_submission",
    payload: {},
    captured_at: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

describe("describeApplicationEvidence", () => {
  it("returns nothing for a plan with no evidence", () => {
    expect(describeApplicationEvidence([])).toEqual([]);
    expect(describeApplicationEvidence(null)).toEqual([]);
    expect(describeApplicationEvidence(undefined)).toEqual([]);
  });

  it("shows a confirmation reference and the resume sent for a successful submission", () => {
    const [view] = describeApplicationEvidence([
      row({
        payload: {
          adapter: "greenhouse",
          endpoint: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/1",
          boardToken: "acme",
          applicationId: 4455667,
          httpStatus: 200,
          credentialSource: "stored",
          resumeFilename: "jane-doe.pdf",
        },
      }),
    ]);

    expect(view.kind).toBe("submission");
    expect(view.title).toBe("Submitted to the employer");
    expect(view.details.join(" ")).toContain("4455667");
    expect(view.details.join(" ")).toContain("jane-doe.pdf");
  });

  /**
   * THE DISCLOSURE BOUNDARY. Adapter payloads carry operational detail — internal
   * endpoints, board tokens, credential provenance, and on the failure path a raw
   * exception message. None of it may reach the candidate, and a field added to a
   * payload later must not appear here by default.
   */
  it("never surfaces payload fields outside the whitelist", () => {
    const [view] = describeApplicationEvidence([
      row({
        payload: {
          applicationId: "ref-1",
          endpoint: "https://internal.example.com/secret-path",
          boardToken: "acme-board",
          credentialSource: "environment",
          fieldsSubmitted: ["first_name", "email"],
          apiKey: "sk-live-should-never-render",
          message: "connect ECONNREFUSED 10.0.0.5:5432",
        },
      }),
    ]);

    const rendered = JSON.stringify(view);

    for (const secret of [
      "internal.example.com",
      "acme-board",
      "environment",
      "sk-live-should-never-render",
      "ECONNREFUSED",
      "10.0.0.5",
      "fieldsSubmitted",
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it("explains a paused application in plain language, not as a raw type token", () => {
    const [view] = describeApplicationEvidence([
      row({ evidence_type: "action_required", payload: { exceptionType: "captcha" } }),
    ]);

    expect(view.kind).toBe("action_required");
    expect(view.title).toBe("Needs your input");
    expect(view.details.join(" ")).toContain("bot check");
    expect(view.details.join(" ")).not.toContain("captcha");
  });

  it("falls back to generic copy for an unrecognised exception type", () => {
    const [view] = describeApplicationEvidence([
      row({ evidence_type: "action_required", payload: { exceptionType: "some_future_reason" } }),
    ]);

    expect(view.details.join(" ")).not.toContain("some_future_reason");
    expect(view.kind).toBe("action_required");
  });

  it("maps a classified failure and states whether it will be retried", () => {
    const [view] = describeApplicationEvidence([
      row({
        evidence_type: "submission_error",
        payload: { message: "boom", reasonCode: "MISSING_REQUIRED_CANDIDATE_FACT", retryable: false },
      }),
    ]);

    expect(view.kind).toBe("failure");
    expect(view.details.join(" ")).toContain("missing from your confirmed facts");
    expect(view.details.join(" ")).toContain("won't be retried");
    // The raw exception message must not be shown.
    expect(view.details.join(" ")).not.toContain("boom");
  });

  it("never shows a raw reason code", () => {
    const [view] = describeApplicationEvidence([
      row({ evidence_type: "submission_error", payload: { reasonCode: "GREENHOUSE_SUBMISSION_REJECTED" } }),
    ]);

    expect(view.details.join(" ")).not.toContain("GREENHOUSE_SUBMISSION_REJECTED");
  });

  it("handles a malformed payload without throwing", () => {
    const views = describeApplicationEvidence([
      row({ payload: null }),
      row({ id: "e2", payload: "a string" }),
      row({ id: "e3", payload: [1, 2, 3] }),
    ]);

    expect(views).toHaveLength(3);
  });

  it("shows an unrecognised evidence type plainly rather than hiding the row", () => {
    const [view] = describeApplicationEvidence([row({ evidence_type: "something_new", payload: {} })]);

    expect(view.kind).toBe("unknown");
    expect(view.title).toBe("Application update");
  });

  it("orders the newest evidence first", () => {
    const views = describeApplicationEvidence([
      row({ id: "old", captured_at: "2026-09-01T10:00:00Z" }),
      row({ id: "new", captured_at: "2026-09-02T10:00:00Z" }),
    ]);

    expect(views.map((view) => view.id)).toEqual(["new", "old"]);
  });
});
