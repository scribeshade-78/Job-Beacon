import { describe, expect, it } from "vitest";
import {
  MATCH_AUTO_THRESHOLD,
  MATCH_REVIEW_THRESHOLD,
  scoreApplicationMatch,
  type CandidateApplication,
} from "./matchApplication.js";

/**
 * FORGEABLE AND PUBLIC SIGNALS MUST NOT AUTO-LINK.
 *
 * Every value below is something an attacker either writes themselves (a From header) or can read
 * off the employer's public job board (the job id, the company, the role). The matcher's job is to
 * put such mail in front of a human, not to bind it to an application.
 */

const STRIPE: CandidateApplication = {
  attemptId: "attempt-1",
  companyName: "Stripe",
  companyDomain: "stripe.com",
  careerDomain: null,
  roleTitle: "Data Engineer",
  sourceVacancyId: "8123027",
};

const OTHER: CandidateApplication = {
  attemptId: "attempt-2",
  companyName: "Vercel",
  companyDomain: "vercel.com",
  careerDomain: null,
  roleTitle: "Frontend Engineer",
  sourceVacancyId: "5999792004",
};

function match(overrides: Partial<{ sender: string; company: string; role: string; jobId: string }>) {
  return scoreApplicationMatch(
    {
      sender: overrides.sender ?? null,
      company: overrides.company ?? null,
      role: overrides.role ?? null,
      jobId: overrides.jobId ?? null,
    },
    [STRIPE, OTHER],
  );
}

describe("a PUBLIC job id cannot auto-link on its own", () => {
  it("drops the exact job id to the review band", () => {
    const result = match({ jobId: "8123027" });

    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0]!.confidence).toBeLessThan(MATCH_AUTO_THRESHOLD);
      expect(result.candidates[0]!.confidence).toBeGreaterThanOrEqual(MATCH_REVIEW_THRESHOLD);
    }
  });

  it("still reaches auto-link once the role corroborates it", () => {
    // Two facts about the application, only one of which is printed on a public board.
    expect(match({ jobId: "8123027", role: "Data Engineer" }).kind).toBe("auto");
  });
});

describe("a spoofed sender domain cannot carry a link over the line", () => {
  it("REFUSES to auto-link on a domain plus a guessable company name", () => {
    // 0.5 + 0.35 used to equal exactly the auto threshold. This is the historical .co.uk bug's
    // arithmetic, and it is the single most important assertion in this file.
    const result = match({ sender: "jobs@stripe.com", company: "Stripe" });

    expect(result.kind).toBe("review");
  });

  it("does not count the sender domain as one of the two independent reasons", () => {
    // Domain + company + role is two independent reasons (company, role), so this MAY auto - and
    // the point is that it needed the role, which the sender had to know.
    const withRole = match({ sender: "jobs@stripe.com", company: "Stripe", role: "Data Engineer" });
    expect(withRole.kind).toBe("auto");
  });

  it("refuses domain + role alone, which is below the threshold anyway", () => {
    expect(match({ sender: "jobs@stripe.com", role: "Data Engineer" }).kind).toBe("review");
  });

  it("refuses a domain alone", () => {
    expect(match({ sender: "jobs@stripe.com" }).kind).toBe("none");
  });
});

describe("an ATS relay still reaches a human", () => {
  it("puts relay + company in the review band, not at auto", () => {
    // Relay domains are a PUBLISHED LIST in the source, so this must not auto-link by itself.
    expect(match({ sender: "no-reply@greenhouse.io", company: "Stripe" }).kind).toBe("review");
  });

  it("auto-links relay + company + role, which is two independent reasons", () => {
    expect(
      match({ sender: "no-reply@greenhouse.io", company: "Stripe", role: "Data Engineer" }).kind,
    ).toBe("auto");
  });
});

describe("the review floor is unchanged", () => {
  it("returns none below the floor", () => {
    expect(match({ company: "Some Unrelated Company" }).kind).toBe("none");
  });

  it("never returns a confidence above 1", () => {
    const result = match({
      sender: "no-reply@greenhouse.io",
      company: "Stripe",
      role: "Data Engineer",
      jobId: "8123027",
    });

    expect(result.kind).toBe("auto");
    if (result.kind === "auto") expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
