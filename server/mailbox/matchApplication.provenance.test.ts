import { describe, expect, it } from "vitest";
import { authVerdict, scoreApplicationMatch, type CandidateApplication } from "./matchApplication.js";

const APP: CandidateApplication = {
  attemptId: "attempt-1",
  companyName: "Stripe",
  companyDomain: "stripe.com",
  careerDomain: null,
  roleTitle: "Data Engineer",
  sourceVacancyId: "8123027",
};

function match(authResults?: string | null) {
  return scoreApplicationMatch(
    { sender: "no-reply@greenhouse.io", company: "Stripe", role: "Data Engineer", jobId: "8123027", authResults },
    [APP],
  );
}

describe("authVerdict - the provider's verdict on the sending domain", () => {
  it.each([
    ["mx.google.com; spf=pass smtp.mailfrom=greenhouse.io", "pass"],
    ["mx.google.com; dkim=pass header.d=greenhouse.io", "pass"],
    ["mx.google.com; spf=fail smtp.mailfrom=evil.example", "fail"],
    ["mx.google.com; spf=softfail smtp.mailfrom=maybe.example", "fail"],
    ["mx.google.com; dkim=fail header.d=evil.example", "fail"],
    ["mx.google.com; dmarc=fail header.from=stripe.com", "fail"],
    ["mx.google.com; spf=temperror smtp.mailfrom=x", "fail"],
    ["mx.google.com; spf=permerror smtp.mailfrom=x", "fail"],
  ])("reads %s as %s", (header, expected) => {
    expect(authVerdict(header)).toBe(expected);
  });

  it("treats ABSENT and EMPTY as unknown, never as a pass", () => {
    expect(authVerdict(undefined)).toBe("unknown");
    expect(authVerdict(null)).toBe("unknown");
    expect(authVerdict("")).toBe("unknown");
    expect(authVerdict("   ")).toBe("unknown");
  });

  it("returns unknown for a header with no recognised mechanism", () => {
    expect(authVerdict("mx.google.com; something-else=pass")).toBe("unknown");
  });

  it("ANY failure wins over a pass in the same header", () => {
    // "spf=pass; dkim=fail" means one mechanism was satisfied and another was not. Checking pass
    // first would let the satisfied one vouch for a message the other rejected.
    expect(authVerdict("mx.google.com; spf=pass; dkim=fail")).toBe("fail");
  });
});

describe("a failed verdict disqualifies an otherwise confident match", () => {
  it("would AUTO-LINK on these signals alone", () => {
    // The control: this exact input is an auto-link without the provenance field.
    expect(match().kind).toBe("auto");
  });

  it("is forced to REVIEW when SPF failed", () => {
    expect(match("mx.google.com; spf=fail smtp.mailfrom=evil.example").kind).toBe("review");
  });

  it("is forced to REVIEW when DKIM failed", () => {
    expect(match("mx.google.com; dkim=fail").kind).toBe("review");
  });

  it("still auto-links on a PASS verdict, which adds evidence rather than removing it", () => {
    expect(match("mx.google.com; spf=pass; dkim=pass").kind).toBe("auto");
  });

  it("still auto-links when the verdict is UNKNOWN - absence is not failure", () => {
    // The other half of the contract. Unknown must not BLOCK either; a provider that sends no
    // header would otherwise send every message to manual review.
    expect(match(null).kind).toBe("auto");
    expect(match("").kind).toBe("auto");
  });

  it("keeps the candidates in the review band so a human has something to look at", () => {
    const result = match("mx.google.com; spf=fail");

    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0]!.attemptId).toBe("attempt-1");
    }
  });
});
