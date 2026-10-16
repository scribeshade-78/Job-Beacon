import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractResumeText } from "./textExtraction.js";

/**
 * THE FIXTURE MUST BE READABLE, OR CI PROVES NOTHING ABOUT THIS PATH.
 *
 * Every seeded resume object in this project was an INVALID PDF — the extractor threw
 * "Invalid PDF structure" on them — so the extraction layer was never exercised by the fixtures
 * that claimed to represent it. That is how an uncapped model call survived in
 * openaiExtraction: nothing parsed a resume end to end for long enough to fail.
 *
 * The file is committed rather than read from Supabase Storage on purpose: CI has no database
 * and no bucket, so a storage-backed fixture would silently skip exactly where the check matters
 * most. This asserts the bytes in the repository, which is the part a developer can break.
 */
const FIXTURE = join(process.cwd(), "server", "resumes", "fixtures", "valid-resume.pdf");

describe("the committed resume fixture", () => {
  it("is a PDF the extraction layer can actually read", async () => {
    const buffer = readFileSync(FIXTURE);
    const text = await extractResumeText(buffer, "application/pdf");

    // Non-empty is the whole point: an unparseable fixture yields "", and an empty resume is
    // what turns a downstream model call into the failure this test exists to prevent.
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("preserves the text the facts are extracted from", async () => {
    const text = await extractResumeText(readFileSync(FIXTURE), "application/pdf");

    expect(text).toContain("PRIYA RAMAN");
    expect(text).toContain("priya.raman@example.com");
    expect(text).toContain("Northwind Digital");
  });

  it("rejects a file that is not a PDF, so the guard cannot pass vacuously", async () => {
    await expect(extractResumeText(Buffer.from("not a pdf at all"), "application/pdf")).rejects.toBeTruthy();
  });
});
