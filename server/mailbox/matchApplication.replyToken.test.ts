import { describe, expect, it } from "vitest";
import { scoreApplicationMatch, type CandidateApplication } from "./matchApplication.js";

/**
 * THE PRECEDENCE TABLE, PROVEN.
 *
 * A verified reply token is the only input to this module that is not a guess about strings, so
 * it is the only one allowed to decide a link without scoring. These tests pin both halves of
 * that: what the token may overrule, and the one thing that still overrules it.
 */

const STRIPE: CandidateApplication = {
  attemptId: "attempt-1",
  companyName: "Stripe",
  companyDomain: "stripe.com",
  careerDomain: null,
  roleTitle: "Data Engineer",
  sourceVacancyId: "8123027",
};

/** Same vacancy, different attempt: the shape that used to force a permanent "ambiguous". */
const LOOKALIKE: CandidateApplication = { ...STRIPE, attemptId: "attempt-2" };

/** Nothing the heuristics can score, so any non-none result must have come from the token. */
const NOTHING = { sender: null, company: null, role: null, jobId: null };

describe("a verified reply token decides before any scoring", () => {
  it("auto-links on the token alone when the heuristic score is ZERO", () => {
    expect(scoreApplicationMatch({ ...NOTHING, verifiedAttemptId: "attempt-1" }, [STRIPE])).toEqual({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 1,
      reasons: ["reply_token_verified"],
    });

    // THE CONTROL. Without the token this exact message is not a link at all, which is what
    // makes the assertion above evidence that the token did the work rather than the scorer.
    expect(scoreApplicationMatch({ ...NOTHING }, [STRIPE])).toEqual({ kind: "none" });
  });

  it("raises a mid-band heuristic to auto instead of leaving it for review", () => {
    const entities = { sender: null, company: "Stripe", role: "Data Engineer", jobId: null };

    // 0.35 + 0.30 = 0.65: above the review floor, below auto. The token does not add to that
    // score, it replaces the question.
    expect(scoreApplicationMatch(entities, [STRIPE]).kind).toBe("review");

    expect(scoreApplicationMatch({ ...entities, verifiedAttemptId: "attempt-1" }, [STRIPE])).toMatchObject({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 1,
    });
  });

  it("breaks a field of identical scores instead of reporting ambiguity", () => {
    const entities = { sender: null, company: "Stripe", role: "Data Engineer", jobId: "8123027" };

    expect(scoreApplicationMatch(entities, [STRIPE, LOOKALIKE]).kind).toBe("ambiguous");

    expect(scoreApplicationMatch({ ...entities, verifiedAttemptId: "attempt-2" }, [STRIPE, LOOKALIKE])).toMatchObject({
      kind: "auto",
      attemptId: "attempt-2",
    });
  });
});

describe("a hard auth failure outranks the token", () => {
  it("routes to review even when the token resolves perfectly", () => {
    const result = scoreApplicationMatch(
      {
        ...NOTHING,
        verifiedAttemptId: "attempt-1",
        authResults: "mx.google.com; spf=fail smtp.mailfrom=evil.example",
      },
      [STRIPE],
    );

    expect(result).toEqual({
      kind: "review",
      candidates: [{ attemptId: "attempt-1", confidence: 1, reasons: ["reply_token_verified"] }],
    });
  });

  it("counts softfail and temperror as failures here too", () => {
    for (const mechanism of ["spf=softfail", "dkim=temperror", "dmarc=permerror"]) {
      const result = scoreApplicationMatch(
        { ...NOTHING, verifiedAttemptId: "attempt-1", authResults: `mx.google.com; ${mechanism} x` },
        [STRIPE],
      );

      expect(result.kind, mechanism).toBe("review");
    }
  });

  it("lets a pass or an unknown verdict through, because the token is not a sender claim", () => {
    expect(
      scoreApplicationMatch(
        { ...NOTHING, verifiedAttemptId: "attempt-1", authResults: "mx.google.com; spf=pass smtp.mailfrom=stripe.com" },
        [STRIPE],
      ).kind,
    ).toBe("auto");

    // Unknown is the normal state for most mail. It must not block a cryptographic identifier.
    expect(scoreApplicationMatch({ ...NOTHING, verifiedAttemptId: "attempt-1", authResults: null }, [STRIPE]).kind).toBe("auto");
    expect(scoreApplicationMatch({ ...NOTHING, verifiedAttemptId: "attempt-1" }, [STRIPE]).kind).toBe("auto");
  });
});

describe("a token that does not match this candidate's applications", () => {
  it("falls through to the heuristics instead of linking an attempt it was not shown", () => {
    expect(scoreApplicationMatch({ ...NOTHING, verifiedAttemptId: "attempt-elsewhere" }, [STRIPE])).toEqual({ kind: "none" });
  });

  it("still lets the heuristics decide when they can", () => {
    const result = scoreApplicationMatch(
      { sender: null, company: "Stripe", role: "Data Engineer", jobId: null, verifiedAttemptId: "attempt-elsewhere" },
      [STRIPE],
    );

    expect(result.kind).toBe("review");
  });
});

describe("without a token", () => {
  it("never reports the token reason, so the heuristic behaviour is unchanged", () => {
    const result = scoreApplicationMatch(
      { sender: null, company: "Stripe", role: "Data Engineer", jobId: "8123027" },
      [STRIPE],
    );

    expect(result.kind).toBe("auto");
    expect(JSON.stringify(result)).not.toContain("reply_token_verified");
  });
});
