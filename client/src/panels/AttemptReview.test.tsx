import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabaseClient", () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok" } } }) },
  }),
}));

import { AttemptReview } from "./AttemptReview";
// The component's own source, so the colour rule is asserted against what actually ships
// rather than against a rendered snapshot that could not see an inline style.
import attemptReviewSource from "./AttemptReview.tsx?raw";

const BASE_TEXT = "Led a team of four engineers";
const TAILORED_TEXT = "Led a team of six engineers";

function previewWith(resume: Record<string, unknown>) {
  return {
    applicationAttemptId: "attempt-1",
    previewUrl: "https://storage.test/cand-1/tailored.pdf?token=signed",
    previewUrlExpiresInSeconds: 300,
    resumePrepared: true,
    resume: {
      documentId: "doc-1",
      originalFilename: "resume.pdf",
      tailored: true,
      optimizationLevel: "honest",
      ...resume,
    },
    coverLetter: { status: "failed", reason: "no cited facts survived the honesty gate" },
  };
}

async function renderAndOpenPreview(resume: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => previewWith(resume) })),
  );

  render(<AttemptReview attemptId="attempt-1" onApproved={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /Review & Approve/i }));
  await screen.findByText("Your tailored resume");
}

// CLEANUP IS EXPLICIT BECAUSE THIS PROJECT DOES NOT SET vitest globals: true.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AttemptReview - the word diff", () => {
  it("renders one removed run and one added run, styled from the status tokens", async () => {
    await renderAndOpenPreview({ baseText: BASE_TEXT, tailoredText: TAILORED_TEXT });

    expect(screen.getByText("What changed")).toBeTruthy();

    const removed = screen.getByText("four");
    const added = screen.getByText("six");

    expect(removed.className).toContain("text-status-blocked-fg");
    expect(added.className).toContain("text-status-verified-fg");
  });

  it("states the size of the change in words, not in segments", async () => {
    await renderAndOpenPreview({ baseText: BASE_TEXT, tailoredText: TAILORED_TEXT });
    expect(screen.getByText(/1 added, 1 removed/)).toBeTruthy();
  });

  it("leaves the unchanged text unstyled, so the change is what draws the eye", async () => {
    await renderAndOpenPreview({ baseText: BASE_TEXT, tailoredText: TAILORED_TEXT });

    // No trailing space: Testing Library normalises whitespace before matching, so the
    // segment "Led a team of " is addressable as "Led a team of".
    const unchanged = screen.getByText("Led a team of");
    expect(unchanged.className).toContain("text-ios-text");
    expect(unchanged.className).not.toContain("text-status");
  });

  it("does NOT render the section when the preview carries no text - WHICH IS EVERY PREVIEW TODAY", async () => {
    // The server sends a PDF URL and four metadata fields, nothing more. This test records
    // that reality rather than leaving it to be discovered from a blank screen later.
    await renderAndOpenPreview({});
    expect(screen.queryByText("What changed")).toBeNull();
  });

  it("does NOT render the section when the resume was not tailored", async () => {
    // Nothing was rewritten, so there is nothing to show and a diff of a document against
    // itself would be noise.
    await renderAndOpenPreview({ tailored: false, baseText: BASE_TEXT, tailoredText: BASE_TEXT });
    expect(screen.queryByText("What changed")).toBeNull();
  });

  it("does NOT render the section on a half-arrived pair", async () => {
    await renderAndOpenPreview({ baseText: BASE_TEXT });
    expect(screen.queryByText("What changed")).toBeNull();
  });

  it("still shows the document and the approve controls alongside the diff", async () => {
    await renderAndOpenPreview({ baseText: BASE_TEXT, tailoredText: TAILORED_TEXT });

    expect(screen.getByRole("button", { name: /Approve for Submission/i })).toBeTruthy();
    expect(screen.getByText(/Open resume.pdf in a new tab/)).toBeTruthy();
    expect(screen.getByText("What changed")).toBeTruthy();
  });

  it("says nothing about wording when the diff was too large to produce", async () => {
    // Two long, wholly unrelated strings defeat the shared-affix trimming, which is exactly
    // what the engine's cell bound exists for. The panel must degnrade to "no diff", not throw.
    const huge = (prefix: string) => Array.from({ length: 2500 }, (_, index) => prefix + index).join(" ");
    await renderAndOpenPreview({ baseText: huge("a"), tailoredText: huge("b") });
    expect(screen.queryByText("What changed")).toBeNull();
    expect(screen.getByRole("button", { name: /Approve for Submission/i })).toBeTruthy();
  });
});

describe("AttemptReview - the colour rule", () => {
  it("hard-codes no colour: every colour is a token class", () => {
    expect(attemptReviewSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(attemptReviewSource).not.toMatch(/\brgba?\(/);
    expect(attemptReviewSource).not.toMatch(/style=\{\{/);
  });

  it("uses the status *-fg variants, which are the ones that clear AA as text", () => {
    // client/src/styles.css documents that the literal status hues measure ~2.2:1 against
    // white; the -fg pair was computed to clear 4.5:1. The diff shows text on a light
    // surface, so it takes the -fg pair and this pins that.
    expect(attemptReviewSource).toContain("text-status-verified-fg");
    expect(attemptReviewSource).toContain("text-status-blocked-fg");
    expect(attemptReviewSource).not.toContain("text-status-verified ");
    expect(attemptReviewSource).not.toContain("text-status-blocked ");
  });
});
