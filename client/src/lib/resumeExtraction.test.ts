import { describe, expect, it, vi } from "vitest";
import { extractResumeFacts, listExtractedFacts } from "./resumeExtraction";

const DEFAULT_FACT_ROW = {
  id: "fact-1",
  source_document_id: "resume-1",
  fact_type: "full_name",
  fact_value: "Jordan Rivera",
  created_at: "2026-08-23T00:00:00Z",
};

function makeListClient(options: {
  factsResult?: { data: unknown; error: unknown };
  confirmationsResult?: { data: unknown; error: unknown };
} = {}) {
  const factsResult = options.factsResult ?? { data: [DEFAULT_FACT_ROW], error: null };
  const confirmationsResult = options.confirmationsResult ?? {
    data: [{ extracted_fact_id: "fact-1", status: "pending", corrected_value: null }],
    error: null,
  };

  const inFn = vi.fn().mockResolvedValue(confirmationsResult);
  const order = vi.fn().mockResolvedValue(factsResult);
  const from = vi.fn((table: string) => {
    if (table === "extracted_facts") {
      return { select: () => ({ order }) };
    }
    if (table === "fact_confirmations") {
      return { select: () => ({ in: inFn }) };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from, inFn } as unknown as Parameters<typeof listExtractedFacts>[0] & { inFn: typeof inFn };
}

describe("listExtractedFacts", () => {
  it("maps rows to camelCase and merges in confirmation status/corrected value", async () => {
    const client = makeListClient({
      confirmationsResult: {
        data: [{ extracted_fact_id: "fact-1", status: "confirmed", corrected_value: "Jordan R. Rivera" }],
        error: null,
      },
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
          confirmationStatus: "confirmed",
          correctedValue: "Jordan R. Rivera",
        },
      ],
    });
  });

  it("defaults to pending/null when a fact has no matching confirmation row (defensive — shouldn't happen in practice)", async () => {
    const client = makeListClient({ confirmationsResult: { data: [], error: null } });

    const result = await listExtractedFacts(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.facts[0].confirmationStatus).toBe("pending");
      expect(result.facts[0].correctedValue).toBeNull();
    }
  });

  it("skips the fact_confirmations query entirely when there are no facts", async () => {
    const client = makeListClient({ factsResult: { data: [], error: null } });

    const result = await listExtractedFacts(client);

    expect(result).toEqual({ kind: "success", facts: [] });
    expect(client.from).not.toHaveBeenCalledWith("fact_confirmations");
  });

  it("returns a generic error on an extracted_facts query failure", async () => {
    const client = makeListClient({ factsResult: { data: null, error: { message: "db down" } } });

    const result = await listExtractedFacts(client);

    expect(result).toEqual({ kind: "error", message: "Could not load extracted facts. Please try again." });
  });

  it("returns a generic error on a fact_confirmations query failure", async () => {
    const client = makeListClient({ confirmationsResult: { data: null, error: { message: "db down" } } });

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
