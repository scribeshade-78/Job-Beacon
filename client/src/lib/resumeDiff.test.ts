import { describe, expect, it } from "vitest";
import {
  diffResumeWords,
  RESUME_DIFF_CELL_LIMIT,
  ResumeDiffTooLargeError,
  summarizeResumeDiff,
  type ResumeDiffSegment,
} from "./resumeDiff";

/**
 * Rebuild one side from the segments.
 *
 * THIS IS THE PROPERTY THE PANEL DEPENDS ON and the cheapest way to assert the diff is not
 * merely plausible: dropping the removed words must give back exactly the base, and dropping
 * the added words must give back exactly the tailored. A diff that "looks right" but loses or
 * duplicates a word would still render convincingly.
 */
function rebuild(segments: readonly ResumeDiffSegment[], side: "base" | "tailored"): string {
  const wanted = side === "base" ? "removed" : "added";
  return segments
    .filter((segment) => segment.kind === "same" || segment.kind === wanted)
    .map((segment) => segment.text)
    .join("");
}

function kinds(segments: readonly ResumeDiffSegment[]): string[] {
  return segments.map((segment) => segment.kind);
}

describe("diffResumeWords - identical and empty inputs", () => {
  it("returns ONE same segment for identical text, not one per word", () => {
    const segments = diffResumeWords("Built APIs with Node", "Built APIs with Node");
    expect(segments).toEqual([{ kind: "same", text: "Built APIs with Node" }]);
  });

  it("returns nothing for two empty strings", () => {
    expect(diffResumeWords("", "")).toEqual([]);
  });

  it("returns the whole tailored text as added when the base is empty", () => {
    expect(diffResumeWords("", "Hello")).toEqual([{ kind: "added", text: "Hello" }]);
  });

  it("returns the whole base text as removed when the tailored text is empty", () => {
    expect(diffResumeWords("Hello", "")).toEqual([{ kind: "removed", text: "Hello" }]);
  });
});

describe("diffResumeWords - insertions and deletions", () => {
  it("marks an inserted word added, and leaves the rest same", () => {
    const segments = diffResumeWords("a b c", "a b x c");
    expect(segments).toEqual([
      { kind: "same", text: "a b " },
      { kind: "added", text: "x " },
      { kind: "same", text: "c" },
    ]);
    expect(rebuild(segments, "base")).toBe("a b c");
    expect(rebuild(segments, "tailored")).toBe("a b x c");
  });

  it("marks a deleted word removed, and leaves the rest same", () => {
    const segments = diffResumeWords("a b c", "a c");
    expect(segments).toEqual([
      { kind: "same", text: "a " },
      { kind: "removed", text: "b " },
      { kind: "same", text: "c" },
    ]);
    expect(rebuild(segments, "base")).toBe("a b c");
    expect(rebuild(segments, "tailored")).toBe("a c");
  });
});

describe("diffResumeWords - replacements", () => {
  it("emits removed BEFORE added, so the pair reads old then new", () => {
    const segments = diffResumeWords("a b c", "a z c");
    expect(segments).toEqual([
      { kind: "same", text: "a " },
      { kind: "removed", text: "b" },
      { kind: "added", text: "z" },
      { kind: "same", text: " c" },
    ]);
    expect(kinds(segments)).toEqual(["same", "removed", "added", "same"]);
  });

  it("splits a longer replacement into several runs, and still rebuilds both sides", () => {
    // DELIBERATELY NOT ASSERTING ONE REMOVED RUN AND ONE ADDED RUN. The LCS keeps the space
    // between "quick brown" and "slow red" because a space really is common to both, so the
    // honest output is two removed/added pairs with a same segment between them. Pinning a
    // single run here would be pinning a wrong expectation.
    const segments = diffResumeWords("the quick brown fox", "the slow red fox");
    expect(kinds(segments).filter((kind) => kind === "removed")).toHaveLength(2);
    expect(kinds(segments).filter((kind) => kind === "added")).toHaveLength(2);
    expect(rebuild(segments, "base")).toBe("the quick brown fox");
    expect(rebuild(segments, "tailored")).toBe("the slow red fox");
    expect(summarizeResumeDiff(segments)).toEqual({ addedWords: 2, removedWords: 2 });
  });
});

describe("diffResumeWords - the reconstruction property", () => {
  // The invariant, over a spread of shapes rather than one hand-picked case.
  const cases: Array<[string, string]> = [
    ["", ""],
    ["one", "one"],
    ["one", "one two"],
    ["one two", "one"],
    ["a b c d e", "a x c y e"],
    ["React, Node\nPython", "React, Node\nGo, Python"],
    ["Led a team of 4 engineers.", "Led a team of 6 engineers across two timezones."],
    ["  leading and trailing  ", "leading and trailing"],
    ["same same same", "same different same"],
    ["alpha", "beta"],
  ];

  it.each(cases)("rebuilds both sides exactly: %j vs %j", (base, tailored) => {
    const segments = diffResumeWords(base, tailored);
    expect(rebuild(segments, "base")).toBe(base);
    expect(rebuild(segments, "tailored")).toBe(tailored);
  });

  it("never emits an empty segment", () => {
    for (const [base, tailored] of cases) {
      for (const segment of diffResumeWords(base, tailored)) {
        expect(segment.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("never emits two adjacent segments of the same kind", () => {
    // They are coalesced, so a consumer can style runs without merging them itself.
    for (const [base, tailored] of cases) {
      const list = kinds(diffResumeWords(base, tailored));
      for (let index = 1; index < list.length; index += 1) {
        expect(list[index]).not.toBe(list[index - 1]);
      }
    }
  });
});

describe("diffResumeWords - whitespace", () => {
  it("preserves the exact spelling of the side it came from", () => {
    // A diff that normalised whitespace would render text that is not in the resume.
    const segments = diffResumeWords("a\tb\nc", "a\tb\nXc");
    expect(rebuild(segments, "base")).toBe("a\tb\nc");
    expect(rebuild(segments, "tailored")).toBe("a\tb\nXc");
  });
});

describe("diffResumeWords - the size bound", () => {
  it("refuses a pair whose LCS table would be unreasonable, rather than hanging a tab", () => {
    // Completely unrelated long inputs defeat the shared-affix trimming, which is exactly
    // the case the bound exists for.
    const words = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => prefix + index).join(" ");
    const big = words("a", 2500);
    const other = words("b", 2500);

    expect(() => diffResumeWords(big, other)).toThrow(ResumeDiffTooLargeError);
  });

  it("states the bound rather than hiding it behind a magic number", () => {
    expect(RESUME_DIFF_CELL_LIMIT).toBeGreaterThan(0);
  });

  it("still diffs a large but REALISTIC resume pair", () => {
    // 600 words a side is a long resume; shared affixes keep the table tiny even when the
    // bodies differ completely.
    const body = (word: string) => Array.from({ length: 300 }, (_, index) => word + index).join(" ");
    const shared = Array.from({ length: 300 }, (_, index) => "shared" + index).join(" ");
    expect(() => diffResumeWords(shared + " " + body("a"), shared + " " + body("b"))).not.toThrow();
  });
});

describe("summarizeResumeDiff", () => {
  it("counts words, not segments or characters", () => {
    const summary = summarizeResumeDiff(diffResumeWords("a b c", "a z c"));
    expect(summary).toEqual({ addedWords: 1, removedWords: 1 });
  });

  it("counts a multi-word replacement", () => {
    const summary = summarizeResumeDiff(diffResumeWords("the quick brown fox", "the slow red fox"));
    expect(summary).toEqual({ addedWords: 2, removedWords: 2 });
  });

  it("is zero for identical text", () => {
    expect(summarizeResumeDiff(diffResumeWords("same", "same"))).toEqual({ addedWords: 0, removedWords: 0 });
  });
});
