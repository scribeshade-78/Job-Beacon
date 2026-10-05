import { describe, expect, it } from "vitest";
import {
  TOKENIZER_VERSION,
  evidenceFingerprint,
  evidenceTokens,
  isCurrentTokenRow,
  tokenizeText,
} from "./evidenceTokens.js";
import { preferredQualifiers } from "./candidateQualifiers.js";

/**
 * The shared tokenizer. These are pure tests; they prove the RULE, not that any
 * database row was written with it.
 */

describe("tokenizeText", () => {
  it("lowercases and splits on punctuation, dropping single characters", () => {
    expect(tokenizeText("Azure, Data-Engineer & SQL")).toEqual(["azure", "data", "engineer", "sql"]);
  });

  it("does not keep a sentence-ending period as part of the token", () => {
    // The bug this rule exists for: "Snowflake." must yield "snowflake".
    expect(tokenizeText("Built on Snowflake.")).toContain("snowflake");
    expect(tokenizeText("Built on Snowflake.")).not.toContain("snowflake.");
  });

  it("keeps + and # inside terms", () => {
    expect(tokenizeText("C++ and C#")).toEqual(["c++", "and", "c#"]);
  });
});

describe("evidenceTokens", () => {
  it("covers the title and the captured description together", () => {
    const tokens = evidenceTokens({ title: "Data Engineer", description: "Azure pipelines." });

    expect(tokens).toContain("data");
    expect(tokens).toContain("engineer");
    expect(tokens).toContain("azure");
    expect(tokens).toContain("pipelines");
  });

  it("is distinct and sorted, so SQL intersection is deterministic", () => {
    const tokens = evidenceTokens({ title: "Azure Azure Data", description: "azure" });

    expect(tokens).toEqual([...new Set(tokens)]);
    expect(tokens).toEqual([...tokens].sort());
  });

  it("indexes from the title alone when no description was captured", () => {
    expect(evidenceTokens({ title: "Data Engineer", description: null })).toEqual(["data", "engineer"]);
  });
});

describe("tokenizer version and fingerprint", () => {
  const input = { title: "Data Engineer", description: "Azure" };

  it("is stable for the same evidence", () => {
    expect(evidenceFingerprint(input)).toBe(evidenceFingerprint({ ...input }));
  });

  it("changes when the captured description changes", () => {
    expect(evidenceFingerprint(input)).not.toBe(evidenceFingerprint({ title: "Data Engineer", description: "AWS" }));
  });

  it("treats a row from another version as stale", () => {
    const current = { tokenizerVersion: TOKENIZER_VERSION, fingerprint: evidenceFingerprint(input) };

    expect(isCurrentTokenRow(current, input)).toBe(true);
    expect(isCurrentTokenRow({ ...current, tokenizerVersion: "evidence-tokens-v0" }, input)).toBe(false);
    expect(isCurrentTokenRow({ ...current, fingerprint: "different" }, input)).toBe(false);
  });
});

describe("qualifier and evidence tokens share one alphabet", () => {
  it("a qualifier token is directly comparable to an evidence token", () => {
    const qualifiers = preferredQualifiers("Azure Data Engineer", "Data Engineer");
    const evidence = evidenceTokens({ title: "Data Engineer", description: "Azure data platform." });

    // This equality is what lets SQL count matches without re-tokenising text.
    expect(qualifiers.every((qualifier) => evidence.includes(qualifier))).toBe(true);
  });
});
