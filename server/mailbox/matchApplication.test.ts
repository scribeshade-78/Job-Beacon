import { describe, expect, it } from "vitest";
import {
  ATS_RELAY_DOMAINS,
  isAtsRelay,
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

  it("does NOT auto-link on an exact ATS job id alone", () => {
    // THE JOB ID IS PUBLIC: it is printed on the employer's own job board, so anyone who can see
    // the posting can put it in an email. It proves WHICH job this mail concerns and nothing at
    // all about who sent it. 0.70 clears the 0.60 review floor and stops short of 0.85, so the
    // message reaches a human instead of binding an application.
    const result = scoreApplicationMatch(input({ jobId: "gh-4021" }), [app()]);

    expect(result.kind).toBe("review");

    if (result.kind === "review") {
      expect(result.candidates[0]!.confidence).toBeCloseTo(0.7);
      expect(result.candidates[0]!.reasons).toEqual(["job_id_exact"]);
    }
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
    // domain 0.5 + company exact 0.35 = 0.85 — NOT also + fuzzy 0.20. The ARITHMETIC is
    // unchanged and still asserted below; what changed is that 0.85 with only ONE independent
    // reason no longer binds. A sender domain is a header the sender writes, so it cannot be the
    // corroboration that carries a link over the line.
    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0]!.confidence).toBeCloseTo(0.85);
      expect(result.candidates[0]!.reasons).toEqual(["sender_domain_match", "company_name_exact"]);
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
    // The ambiguity rule only runs for candidacies that REACH auto, so this input now needs two
    // independent reasons: the job id alone lands in review and never gets here.
    const result = scoreApplicationMatch(
      input({ jobId: "GH-4021", sender: "x@acme.com", company: "Acme Corp" }),
      [app({ attemptId: "a1" }), app({ attemptId: "a2" })],
    );
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
    // The point of this test is the ZERO-SIGNAL application, not the winner's verdict: whatever
    // the outcome, the app that matched nothing must never be the link target.
    expect(result.kind).not.toBe("auto");
    expect(JSON.stringify(result)).not.toContain("nomatch");
  });
});

describe("registrableDomain — the public suffix list", () => {
  it("does NOT collapse a two-label public suffix to the suffix itself", () => {
    // THE BUG THIS REPLACED. Taking the last two labels unconditionally made every .co.uk host
    // registrable-domain to "co.uk", so an unrelated UK agency matched the employer's domain
    // outright. That is a fabricated signal worth 0.5, and it was enough to auto-link a stranger's
    // email at 1.00 confidence.
    expect(registrableDomain("talentagency.co.uk")).toBe("talentagency.co.uk");
    expect(registrableDomain("northwind.co.uk")).toBe("northwind.co.uk");
    expect(registrableDomain("jobs.northwind.co.uk")).toBe("northwind.co.uk");
  });

  it("handles the other common multi-label suffixes", () => {
    expect(registrableDomain("acme.com.au")).toBe("acme.com.au");
    expect(registrableDomain("acme.co.jp")).toBe("acme.co.jp");
    expect(registrableDomain("acme.co.in")).toBe("acme.co.in");
  });

  it("returns NULL for a bare public suffix, which is the fail-closed direction", () => {
    // A null registrable domain cannot equal anything, so a host that is only a suffix can never
    // manufacture a sender_domain_match.
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("com")).toBeNull();
  });
});

describe("isAtsRelay", () => {
  it("recognises a vendor and its tenant and regional subdomains", () => {
    expect(isAtsRelay("no-reply@greenhouse.io")).toBe(true);
    expect(isAtsRelay("Acme Talent <jobs@eu.greenhouse.io>")).toBe(true);
    expect(isAtsRelay("no-reply@acme.myworkdayjobs.com")).toBe(true);
  });

  it("does not recognise an ordinary domain, or one that merely ends in a vendor's name", () => {
    expect(isAtsRelay("recruiting@acme.com")).toBe(false);
    expect(isAtsRelay("jobs@notgreenhouse.io")).toBe(false);
    expect(isAtsRelay(null)).toBe(false);
    expect(isAtsRelay("no-at-sign")).toBe(false);
  });

  it("keeps the vendor set curated, because an entry here manufactures evidence", () => {
    // A wrong entry promotes an exact company name from 0.35 to 0.65, so this is a reviewed list
    // rather than a heuristic. The assertion is a canary: it fails when somebody adds one.
    expect(ATS_RELAY_DOMAINS.size).toBe(28);
    expect(ATS_RELAY_DOMAINS.has("greenhouse.io")).toBe(true);
    expect(ATS_RELAY_DOMAINS.has("gmail.com")).toBe(false);
  });
});

describe("scoreApplicationMatch — ATS relay senders", () => {
  it("clears the review floor on an exact company name from a vendor, WITHOUT auto-linking", () => {
    // THE COMMONEST MAIL IN THE SYSTEM. A rejection relayed by the ATS that sent it: the sender is
    // the vendor, never the employer, so the domain never matches and the name alone used to score
    // 0.35 - below the floor, so the email was discarded entirely.
    const result = scoreApplicationMatch(
      input({ sender: "Acme via Greenhouse <no-reply@greenhouse.io>", company: "Acme Corp" }),
      [app()],
    );

    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0]!.confidence).toBeCloseTo(0.65);
      expect(result.candidates[0]!.reasons).toEqual(["relay_company_exact"]);
    }
  });

  it("does NOT stack the relay weight on the ordinary exact-name weight", () => {
    // 0.65 + 0.35 would be 1.00 from a vendor domain and a company name alone - a confident wrong
    // link to whichever of the employer's applications happened to come first.
    const result = scoreApplicationMatch(input({ sender: "no-reply@greenhouse.io", company: "Acme Corp" }), [app()]);

    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0]!.confidence).toBeLessThan(0.85);
      expect(result.candidates[0]!.reasons).not.toContain("company_name_exact");
    }
  });

  it("still reaches auto when the relayed mail ALSO names the role or the job id", () => {
    // Independent evidence, so crossing the auto line is right rather than lucky.
    const result = scoreApplicationMatch(
      input({ sender: "no-reply@greenhouse.io", company: "Acme Corp", role: "Senior Backend Engineer" }),
      [app()],
    );

    expect(result.kind).toBe("auto");
    if (result.kind === "auto") {
      expect(result.confidence).toBeCloseTo(0.95);
    }
  });

  it("auto-links a relayed mail that carries the ATS job id", () => {
    const result = scoreApplicationMatch(
      input({ sender: "no-reply@greenhouse.io", company: "Acme Corp", jobId: "GH-4021" }),
      [app()],
    );

    expect(result.kind).toBe("auto");
  });

  it("leaves an ordinary employer domain on the old arithmetic, but no longer auto-links", () => {
    // The relay path must not have quietly become the default: the SCORE is still 0.85.
    const result = scoreApplicationMatch(input({ sender: "recruiting@acme.com", company: "Acme Corp" }), [app()]);

    expect(result.kind).toBe("review");
    if (result.kind === "review") {
      expect(result.candidates[0]!.confidence).toBeCloseTo(0.85);
      expect(result.candidates[0]!.reasons).toEqual(["sender_domain_match", "company_name_exact"]);
    }
  });
});
