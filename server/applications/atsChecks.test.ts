import { describe, expect, it, vi } from "vitest";
import { MIN_DOCUMENT_BYTES, runAtsFormatChecks } from "./atsChecks.js";

/**
 * PRD v3 §16.3's "formatting and ATS quality checks". Each check corresponds to a
 * real way a resume fails at an ATS, so each is asserted independently — a single
 * "it passes" test would hide three dead checks.
 */

function bytes(size: number): Uint8Array {
  return new Uint8Array(size).fill(65);
}

function withText(text: string) {
  return { extractText: vi.fn(async () => text) };
}

const GOOD_TEXT = "Jordan Rivera\nBackend Engineer\n" + "Experience with distributed systems. ".repeat(12);

describe("runAtsFormatChecks", () => {
  it("passes a well-formed PDF with extractable text", async () => {
    const outcome = await runAtsFormatChecks(bytes(4096), "application/pdf", withText(GOOD_TEXT));

    expect(outcome.passed).toBe(true);
    expect(outcome.checks.every((check) => check.passed)).toBe(true);
    expect(outcome.extractedTextChars).toBeGreaterThanOrEqual(200);
  });

  it("rejects a format no ATS will parse, and does not attempt extraction", async () => {
    const extractText = vi.fn(async () => GOOD_TEXT);
    const outcome = await runAtsFormatChecks(bytes(4096), "image/png", { extractText });

    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((check) => check.id === "supported_format")?.passed).toBe(false);
    // Extraction on an unsupported type would raise UnsupportedResumeFormatError
    // and turn a clear result into a crash.
    expect(extractText).not.toHaveBeenCalled();
  });

  it("rejects a file too small to be a document", async () => {
    const outcome = await runAtsFormatChecks(bytes(MIN_DOCUMENT_BYTES - 1), "application/pdf", withText(GOOD_TEXT));

    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((check) => check.id === "non_trivial_size")?.passed).toBe(false);
  });

  it("rejects an image-only document that extracts no text — the silent ATS failure", async () => {
    const outcome = await runAtsFormatChecks(bytes(4096), "application/pdf", withText("   "));

    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((check) => check.id === "text_extractable")?.passed).toBe(false);
    // Downstream checks report as skipped rather than falsely passing.
    expect(outcome.checks.find((check) => check.id === "sufficient_text")?.detail).toContain("skipped");
  });

  it("rejects a document whose text is too short to be a resume", async () => {
    const outcome = await runAtsFormatChecks(bytes(4096), "application/pdf", withText("Jordan Rivera"));

    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((check) => check.id === "sufficient_text")?.passed).toBe(false);
  });

  it("reports an extraction failure rather than throwing", async () => {
    const outcome = await runAtsFormatChecks(bytes(4096), "application/pdf", {
      extractText: vi.fn(async () => {
        throw new Error("pdf-parse exploded");
      }),
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.checks.find((check) => check.id === "text_extractable")?.detail).toContain("pdf-parse exploded");
  });

  it.each([
    ["mustache", "Dear {{candidate_name}}, welcome."],
    ["todo", "TODO: add metrics here."],
    ["lorem_ipsum", "Lorem ipsum dolor sit amet."],
    ["insert_marker", "[insert company name] is hiring."],
    ["your_name_here", "Your Name Here, Engineer."],
  ])("rejects a surviving %s placeholder", async (id, text) => {
    const outcome = await runAtsFormatChecks(bytes(4096), "application/pdf", withText(GOOD_TEXT + " " + text));

    expect(outcome.passed).toBe(false);
    const check = outcome.checks.find((entry) => entry.id === "no_placeholder_tokens");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain(id);
  });

  it("returns every check, not just the first failure, so the record is complete", async () => {
    const outcome = await runAtsFormatChecks(bytes(10), "image/png");

    expect(outcome.checks.map((check) => check.id)).toEqual([
      "supported_format",
      "non_trivial_size",
      "text_extractable",
      "sufficient_text",
      "no_placeholder_tokens",
    ]);
    expect(outcome.passed).toBe(false);
  });
});
