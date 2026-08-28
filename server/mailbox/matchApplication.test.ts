import { describe, expect, it } from "vitest";
import {
  jaccard,
  normalizeText,
  registrableDomain,
  scoreApplicationMatch,
  senderDomain,
  tokenSet,
  type CandidateApplication,
  type MatchInput,
} from "./matchApplication.js";

function app(overrides: Partial<CandidateApplication> = {}): CandidateApplication {
  return {
    attemptId: "attempt-1",
    companyName: "Acme Corp",
    companyDomain: "acme.com",
    careerDomain: "careers.acme.com",
    roleTitle: "Senior Backend Engineer",
    sourceVacancyId: "GH-4021",
    ...overrides,
  };
}

function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return { sender: null, company: null, role: null, jobId: null, ...overrides };
}

describe("normalizeText", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeText("  Señor  Back-End  Engineer!! ")).toBe("senor back end engineer");
  });
  it("returns empty string for null/empty", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText("   ")).toBe("");
  });
});

describe("jaccard", () => {
  it("is 0 when either set is empty", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
  });
  it("is the intersection over union of tokens", () => {
    expect(jaccard(tokenSet("backend engineer"), tokenSet("backend engineer"))).toBe(1);
    expect(jaccard(tokenSet("senior backend engineer"), tokenSet("backend engineer"))).toBeCloseTo(2 / 3);
  });
});

describe("senderDomain", () => {
  it("extracts the host from a display-name wrapped address", () => {
    expect(senderDomain("Acme Recruiting <jobs@careers.acme.com>")).toBe("careers.acme.com");
  });
  it("extracts the host from a bare address", () => {
    expect(senderDomain("noreply@greenhouse.io")).toBe("greenhouse.io");
  });
  it("returns null when there is no @", () => {
    expect(senderDomain("Acme Recruiting")).toBeNull();
    expect(senderDomain(null)).toBeNull();
  });
});

describe("registrableDomain", () => {
  it("keeps the last two labels", () => {
    expect(registrableDomain("careers.acme.com")).toBe("acme.com");
    expect(registrableDomain("acme.com")).toBe("acme.com");
  });
  it("returns null for a single label or empty", () => {
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain(null)).toBeNull();
  });
});

describe("scoreApplicationMatch", () => {
  it("returns none when there are no applications", () => {
    expect(scoreApplicationMatch(input({ company: "Acme Corp" }), [])).toEqual({ kind: "none" });
  });

  it("returns none when every extracted field is null", () => {
    expect(scoreApplicationMatch(input(), [app()])).toEqual({ kind: "none" });
  });

  it("auto-links on an exact ATS job id alone (0.95)", () => {
    const result = scoreApplicationMatch(input({ jobId: "gh-4021" }), [app()]);
    expect(result).toEqual({
      kind: "auto",
      attemptId: "attempt-1",
      confidence: 0.95,
      reasons: ["job_id_exact"],
    });
  });

  it("auto-links on sender domain + exact company + exact role", () => {
    const result = scoreApplicationMatch(
      input({
        sender: "Acme Talent <recruiting@acme.com>",
        company: "Acme Corporation",
        role: "Senior Backend Engineer",
      }),
      [app()],
    );
    expect(result.kind).toBe("auto");
    if (result.kind === "auto") {
      expect(result.confidence).toBe(1); // 0.5 + 0.35 + 0.3 = 1.15, capped
      expect(result.reasons).toEqual(["sender_domain_match", "company_name_exact", "role_title_exact"]);
    }
  });

  it("matches sender domain against the career subdomain too", () => {
    const result = scoreApplicationMatch(
      input({ sender: "jobs@careers.acme.com", role: "Senior Backend Engineer" }),
      [app({ companyDomain: null })],
    );
    expect(result.kind).toBe("review"); // 0.5 + 0.3 = 0.8, below auto
    if (result.kind === "review") {
      expect(result.candidates[0].reasons).toContain("sender_domain_match");
    }
  });

  it("caps confidence at 1.0 when many signals stack", () => {
    const result = scoreApplicationMatch(
      input({
        jobId: "GH-4021",
        sender: "recruiting@acme.com",
        company: "Acme Corp",
        role: "Senior Backend Engineer",
      }),
      [app()],
    );
    expect(result.kind).toBe("auto");
    if (result.kind === "auto") {
      expect(result.confidence).toBe(1);
    }
  });

  it("does not double-count exact and fuzzy for the same field", () => {
    const result = scoreApplicationMatch(
      input({ sender: "x@acme.com", company: "Acme Corp" }),
      [app()],
    );
    // domain 0.5 + company exact 0.35 = 0.85 — NOT also + fuzzy 0.20
    expect(result.kind).toBe("auto");
    if (result.kind === "auto") {
      expect(result.confidence).toBeCloseTo(0.85);
      expect(result.reasons).toEqual(["sender_domain_match", "company_name_exact"]);
    }
  });

  it("uses fuzzy company match when names overlap but are not identical", () => {
    const result = scoreApplicationMatch(
      input({ sender: "x@acme.com", company: "Acme Cloud Corp" }),
      [app({ companyName: "Acme Cloud Platform Corp" })],
    );
    if (result.kind === "review" || result.kind === "auto") {
      const reasons = result.kind === "auto" ? result.reasons : result.candidates[0].reasons;
      expect(reasons).toContain("company_name_fuzzy");
    } else {
      throw new Error(`expected a scored result, got ${result.kind}`);
    }
  });

  it("returns review (not auto) for a mid-band single signal", () => {
    const result = scoreApplicationMatch(input({ sender: "recruiting@acme.com", role: "Backend Engineer" }), [app()]);
    // domain 0.5 + role fuzzy 0.15 = 0.65
    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0].confidence).toBeCloseTo(0.65);
    }
  });

  it("returns none for a weak single signal below the review threshold", () => {
    const result = scoreApplicationMatch(input({ role: "Senior Backend Engineer" }), [app()]);
    // role exact 0.3 only
    expect(result).toEqual({ kind: "none" });
  });

  it("is ambiguous when two applications score above auto within the margin", () => {
    const result = scoreApplicationMatch(input({ jobId: "GH-4021" }), [
      app({ attemptId: "a1", sourceVacancyId: "GH-4021" }),
      app({ attemptId: "a2", sourceVacancyId: "gh-4021" }),
    ]);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.attemptId).sort()).toEqual(["a1", "a2"]);
    }
  });

  it("auto-links the clear winner when a second application scores well below it", () => {
    const result = scoreApplicationMatch(
      input({ jobId: "GH-4021", sender: "x@acme.com", company: "Acme Corp" }),
      [
        app({ attemptId: "strong" }),
        app({ attemptId: "weak", sourceVacancyId: "OTHER", companyName: "Acme Corp", companyDomain: null, careerDomain: null }),
      ],
    );
    expect(result.kind).toBe("auto");
    if (result.kind === "auto") {
      expect(result.attemptId).toBe("strong");
    }
  });

  it("never links a candidate with zero matching signals even if others match", () => {
    const result = scoreApplicationMatch(input({ jobId: "GH-4021" }), [
      app({ attemptId: "match" }),
      app({ attemptId: "nomatch", sourceVacancyId: "ZZ-9", companyName: null, companyDomain: null, careerDomain: null, roleTitle: null }),
    ]);
    expect(result.kind).toBe("auto");
    if (result.kind === "auto") {
      expect(result.attemptId).toBe("match");
    }
  });
});
