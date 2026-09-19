import { describe, expect, it } from "vitest";
import { extractJd, UnknownJdSourceError, htmlToText, htmlToSections } from "./jdExtraction.js";

describe("htmlToText", () => {
  it("decodes entities, turns block closes into newlines, strips tags", () => {
    const html = "<h2>About</h2><p>We use React &amp; Node.</p><ul><li>TypeScript</li><li>AWS</li></ul>";
    const text = htmlToText(html);
    expect(text).toContain("About");
    expect(text).toContain("We use React & Node.");
    expect(text).toContain("• TypeScript");
    expect(text).toContain("• AWS");
    expect(text).not.toContain("<");
  });

  it("decodes numeric entities", () => {
    expect(htmlToText("caf&#233; &#x26; more")).toBe("café & more");
  });
});

describe("htmlToSections", () => {
  it("splits on h1-h4 headings and keeps a leading unlabelled section", () => {
    const html = "<p>Intro line.</p><h3>Responsibilities</h3><p>Build things.</p><h3>Requirements</h3><p>5y experience.</p>";
    const sections = htmlToSections(html);
    expect(sections).toEqual([
      { heading: null, body: "Intro line." },
      { heading: "Responsibilities", body: "Build things." },
      { heading: "Requirements", body: "5y experience." },
    ]);
  });

  it("returns a single unlabelled section when there are no headings", () => {
    expect(htmlToSections("<p>Just a paragraph.</p>")).toEqual([{ heading: null, body: "Just a paragraph." }]);
  });
});

describe("extractJd", () => {
  it("throws UnknownJdSourceError for an unregistered source_code", () => {
    expect(() => extractJd("monster", {})).toThrow(UnknownJdSourceError);
  });

  it("greenhouse: decodes the escaped `content` HTML into text + sections + html snapshot", () => {
    const raw = {
      id: 123,
      absolute_url: "https://boards.greenhouse.io/acme/jobs/123",
      // Greenhouse returns `content` as HTML wrapped in an extra layer of entity-escaping.
      content: "&lt;h3&gt;Responsibilities&lt;/h3&gt;&lt;p&gt;Own the pipeline &amp;amp; ship.&lt;/p&gt;",
    };
    const result = extractJd("greenhouse", raw);
    expect(result.canonicalUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(result.cleanText).toContain("Responsibilities");
    expect(result.cleanText).toContain("Own the pipeline & ship.");
    expect(result.sections[0]).toEqual({ heading: "Responsibilities", body: "Own the pipeline & ship." });
    expect(result.htmlSnapshot).toContain("<h3>Responsibilities</h3>");
  });

  it("greenhouse: no `content` field yields an empty result, not a throw", () => {
    const result = extractJd("greenhouse", { id: 1, absolute_url: "https://x/y" });
    expect(result.cleanText).toBe("");
    expect(result.sections).toEqual([]);
    expect(result.canonicalUrl).toBe("https://x/y");
  });

  it("lever: uses descriptionPlain plus one section per lists[] entry", () => {
    const raw = {
      hostedUrl: "https://jobs.lever.co/acme/abc",
      descriptionPlain: "We are hiring a platform engineer.",
      description: "<p>We are hiring a platform engineer.</p>",
      lists: [
        { text: "What you'll do", content: "<li>Design services</li><li>On-call</li>" },
        { text: "What we need", content: "<li>Go</li>" },
      ],
    };
    const result = extractJd("lever", raw);
    expect(result.canonicalUrl).toBe("https://jobs.lever.co/acme/abc");
    expect(result.sections[0]).toEqual({ heading: null, body: "We are hiring a platform engineer." });
    expect(result.sections[1]).toEqual({ heading: "What you'll do", body: "• Design services\n• On-call" });
    expect(result.sections[2]).toEqual({ heading: "What we need", body: "• Go" });
    expect(result.cleanText).toContain("platform engineer");
    expect(result.htmlSnapshot).toContain("Design services");
  });

  it("adzuna: passes through the short plain description as one section, no html snapshot", () => {
    const raw = { redirect_url: "https://adzuna/land/1", description: "Backend role. Python, Postgres. Apply now…" };
    const result = extractJd("adzuna", raw);
    expect(result.canonicalUrl).toBe("https://adzuna/land/1");
    expect(result.cleanText).toBe("Backend role. Python, Postgres. Apply now…");
    expect(result.sections).toEqual([{ heading: null, body: "Backend role. Python, Postgres. Apply now…" }]);
    expect(result.htmlSnapshot).toBeNull();
  });

  it("jooble: passes through the truncated snippet as one section, no html snapshot", () => {
    const raw = {
      link: "https://ua.jooble.org/jdp/12345",
      snippet: "This is a great opportunity to join our team...",
      type: "Full-time",
    };
    const result = extractJd("jooble", raw);
    expect(result.canonicalUrl).toBe("https://ua.jooble.org/jdp/12345");
    expect(result.cleanText).toBe("This is a great opportunity to join our team...");
    expect(result.sections).toEqual([
      { heading: null, body: "This is a great opportunity to join our team..." },
    ]);
    expect(result.htmlSnapshot).toBeNull();
  });

  it("usajobs: maps UserArea.Details fields to labelled sections", () => {
    const raw = {
      PositionURI: "https://usajobs.gov/job/1",
      UserArea: {
        Details: {
          JobSummary: "Serve the public.",
          MajorDutiesList: ["Analyse data", "Write reports"],
          QualificationSummary: "Bachelor's degree.",
        },
      },
    };
    const result = extractJd("usajobs", raw);
    expect(result.canonicalUrl).toBe("https://usajobs.gov/job/1");
    expect(result.sections).toEqual([
      { heading: "Summary", body: "Serve the public." },
      { heading: "Duties", body: "• Analyse data\n• Write reports" },
      { heading: "Qualifications", body: "Bachelor's degree." },
    ]);
    expect(result.htmlSnapshot).toBeNull();
  });

  it("usajobs: a summary-only descriptor (no UserArea.Details) yields an empty result", () => {
    const result = extractJd("usajobs", { PositionURI: "https://usajobs.gov/job/2", PositionTitle: "Analyst" });
    expect(result.cleanText).toBe("");
    expect(result.sections).toEqual([]);
  });
});

describe("extractJd — remotive", () => {
  /**
   * The shape that matters. Task A2's on-demand scoring was dead-lettering
   * every Remotive vacancy with UnknownJdSourceError, so the source could be
   * ingested and displayed but never ranked.
   */
  const remotiveRaw = {
    id: 2091129,
    url: "https://remotive.com/remote-jobs/data/senior-data-scientist-2091129",
    title: "Senior Data Scientist",
    company_name: "Lemon.io",
    description:
      "<p>Join our data team.</p><h3>Responsibilities</h3><ul><li>Build models</li><li>Own reporting</li></ul><h3>Requirements</h3><p>5 years with Python &amp; SQL.</p>",
  };

  it("extracts section boundaries from the HTML description", () => {
    const result = extractJd("remotive", remotiveRaw);

    expect(result.sections).toEqual([
      { heading: null, body: "Join our data team." },
      { heading: "Responsibilities", body: "• Build models\n• Own reporting" },
      { heading: "Requirements", body: "5 years with Python & SQL." },
    ]);
  });

  it("decodes entities rather than storing them raw", () => {
    expect(extractJd("remotive", remotiveRaw).cleanText).toContain("Python & SQL");
    expect(extractJd("remotive", remotiveRaw).cleanText).not.toContain("&amp;");
  });

  it("uses Remotive's own URL as the canonical URL", () => {
    expect(extractJd("remotive", remotiveRaw).canonicalUrl).toBe(
      "https://remotive.com/remote-jobs/data/senior-data-scientist-2091129",
    );
  });

  it("keeps the raw HTML as the snapshot", () => {
    expect(extractJd("remotive", remotiveRaw).htmlSnapshot).toContain("<h3>Responsibilities</h3>");
  });

  it("yields empty text rather than throwing when a posting has no description", () => {
    // A missing field is "no JD text available", which the worker handles by
    // not persisting a snapshot — it is not an extraction failure.
    const result = extractJd("remotive", { url: "https://remotive.com/x", title: "x" });

    expect(result.cleanText).toBe("");
    expect(result.sections).toEqual([]);
    expect(result.canonicalUrl).toBe("https://remotive.com/x");
  });

  it("still refuses a genuinely unregistered source", () => {
    expect(() => extractJd("monster", remotiveRaw)).toThrow(UnknownJdSourceError);
  });
});
