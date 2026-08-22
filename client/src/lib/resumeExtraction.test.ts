import { describe, expect, it, vi } from "vitest";
import { extractResumeFacts, listExtractedFacts } from "./resumeExtraction";

function makeListClient(result: { data: unknown; error: unknown }) {
  const order = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ order }));
  const from = vi.fn(() => ({ select }));
  return { from } as unknown as Parameters<typeof listExtractedFacts>[0];
}

describe("listExtractedFacts", () => {
  it("maps rows to camelCase, including sourceDocumentId for grouping", async () => {
    const client = makeListClient({
      data: [
        {
          id: "fact-1",
          source_document_id: "resume-1",
          fact_type: "full_name",
          fact_value: "Jordan Rivera",
          created_at: "2026-08-23T00:00:00Z",
        },
      ],
      error: null,
    });

    const result = await listExtractedFacts(client);

    expect(result).toEqual({
      kind: "success",
      facts: [
        {
          id: "fact-1",
          sourceDocumentId: "resume-1",
          factType: "full_name",
          factValue: "Jordan Rivera",
          createdAt: "2026-08-23T00:00:00Z",
        },
      ],
    });
  });

  it("returns a generic error on a query failure", async () => {
    const client = makeListClient({ data: null, error: { message: "db down" } });

    const result = await listExtractedFacts(client);

    expect(result).toEqual({ kind: "error", message: "Could not load extracted facts. Please try again." });
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });

    const result = await listExtractedFacts({ from } as unknown as Parameters<typeof listExtractedFacts>[0]);

    expect(result).toEqual({ kind: "error", message: "Could not load extracted facts. Please try again." });
  });
});

describe("extractResumeFacts", () => {
  it("posts to the extract endpoint with a bearer token and returns the facts on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ facts: [{ id: "fact-1", factType: "full_name", factValue: "Jordan Rivera" }] }),
    });

    const result = await extractResumeFacts("resume-1", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      kind: "success",
      facts: [{ id: "fact-1", factType: "full_name", factValue: "Jordan Rivera" }],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/resumes/resume-1/extract", {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("surfaces the server's error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Resume not found." }),
    });

    const result = await extractResumeFacts("resume-1", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "Resume not found." });
  });

  it("falls back to a generic message when the error body isn't usable JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });

    const result = await extractResumeFacts("resume-1", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      kind: "error",
      message: "Could not extract facts from this resume. Please try again.",
    });
  });

  it("returns a network-error message when fetch itself throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await extractResumeFacts("resume-1", "tok", fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});
