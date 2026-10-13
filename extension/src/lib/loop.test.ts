
import { describe, expect, it } from "vitest";
import { classifySubmissionEvidence, readAttemptId } from "./loop";

describe("readAttemptId", () => {
  it("reads the id the Tracker appended", () => {
    expect(readAttemptId("https://boards.greenhouse.io/acme/jobs/1?jb_attempt_id=abc-123")).toBe("abc-123");
  });

  it("finds it beside other query parameters", () => {
    expect(readAttemptId("https://jobs.lever.co/x?utm_source=y&jb_attempt_id=abc")).toBe("abc");
  });

  it("returns undefined when the extension was not the one that opened the page", () => {
    // The overwhelmingly common case: a candidate browsing normally. The extension must do
    // nothing at all rather than guess an attempt.
    expect(readAttemptId("https://boards.greenhouse.io/acme/jobs/1")).toBeUndefined();
    expect(readAttemptId("https://example.com/?other=1")).toBeUndefined();
  });

  it("returns undefined for a blank or missing value instead of an empty string", () => {
    expect(readAttemptId("https://x.test/j?jb_attempt_id=")).toBeUndefined();
    expect(readAttemptId("https://x.test/j?jb_attempt_id=%20")).toBeUndefined();
  });

  it("returns undefined for an unparseable URL rather than throwing", () => {
    expect(readAttemptId("not a url")).toBeUndefined();
    expect(readAttemptId("")).toBeUndefined();
  });
});

describe("classifySubmissionEvidence - the honest outcome", () => {
  it("reports succeeded when a confirmation URL was seen", () => {
    const result = classifySubmissionEvidence({
      confirmationUrl: "https://boards.greenhouse.io/acme/jobs/1/confirmation",
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.evidence).toMatchObject({ confirmationUrl: "https://boards.greenhouse.io/acme/jobs/1/confirmation" });
  });

  it("reports succeeded when only confirmation TEXT was seen", () => {
    const result = classifySubmissionEvidence({ confirmationText: "Application Submitted" });
    expect(result.outcome).toBe("succeeded");
  });

  it("reports needs_verification when the click produced NOTHING - the whole point", () => {
    // The click did not throw. That is not evidence that anything was sent, and treating it
    // as success would mark an application submitted that may never have left the browser.
    expect(classifySubmissionEvidence({}).outcome).toBe("needs_verification");
  });

  it("treats blank strings as nothing seen, not as evidence", () => {
    expect(classifySubmissionEvidence({ confirmationUrl: "", confirmationText: "   " }).outcome).toBe("needs_verification");
  });

  it("reports failed when the submission threw and nothing confirmed it", () => {
    const result = classifySubmissionEvidence({ error: { message: "The submit button was not found" } });
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatchObject({ message: "The submit button was not found" });
  });

  it("PREFERS proof over an error - a throw after a confirmation does not undo it", () => {
    // Something can go wrong after the portal has already accepted the application. The
    // confirmation is positive evidence; a later error must not downgrade it to failed.
    const result = classifySubmissionEvidence({
      confirmationText: "Thank you for applying",
      error: { message: "network dropped while closing the tab" },
    });
    expect(result.outcome).toBe("succeeded");
  });

  it("does not carry evidence on a failed outcome, or an error on a success", () => {
    const failed = classifySubmissionEvidence({ error: { message: "boom" } });
    expect(failed.evidence).toBeUndefined();
    const ok = classifySubmissionEvidence({ confirmationText: "Submitted" });
    expect(ok.error).toBeUndefined();
  });
});
