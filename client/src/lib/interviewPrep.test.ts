import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearInterviewPrepCache,
  getCachedInterviewPrep,
  requestInterviewPrep,
  setCachedInterviewPrep,
  type InterviewPrep,
} from "./interviewPrep";

const PREP: InterviewPrep = {
  technical_questions: [{ question: "How do you tune Postgres?", topic: "Postgres", why: "The JD requires it." }],
  behavioral_questions: [{ question: "Describe a conflict.", competency: "conflict resolution", why: "Cross-team." }],
  star_talking_points: [],
  gaps: ["Kubernetes"],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A response whose body is not JSON at all. */
function unparseableResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

afterEach(() => {
  clearInterviewPrepCache();
});

describe("requestInterviewPrep", () => {
  it("POSTs to the vacancy's endpoint with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, PREP));

    await requestInterviewPrep("vac-1", "tok-123", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/vacancies/vac-1/interview-prep", {
      method: "POST",
      headers: { Authorization: "Bearer tok-123" },
    });
  });

  it("returns the prep on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, PREP));

    await expect(requestInterviewPrep("vac-1", "tok", fetchImpl)).resolves.toEqual({ kind: "success", prep: PREP });
  });

  it("maps a 422 to unavailable, carrying the server's explanation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(422, { error: "Interview preparation is only available for verified vacancies." }));

    const result = await requestInterviewPrep("vac-1", "tok", fetchImpl);

    // unavailable, not error: a 4xx is a decision on the merits, so the UI must
    // not offer a retry for it.
    expect(result).toEqual({
      kind: "unavailable",
      message: "Interview preparation is only available for verified vacancies.",
    });
  });

  it("maps a 404 to unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: "Vacancy not found." }));

    expect(await requestInterviewPrep("vac-1", "tok", fetchImpl)).toEqual({
      kind: "unavailable",
      message: "Vacancy not found.",
    });
  });

  it("maps a 401 to unavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized" }));

    expect((await requestInterviewPrep("vac-1", "tok", fetchImpl)).kind).toBe("unavailable");
  });

  it("maps a 500 to error, because a retry is worth offering", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "OpenRouter 503" }));

    expect(await requestInterviewPrep("vac-1", "tok", fetchImpl)).toEqual({
      kind: "error",
      message: "OpenRouter 503",
    });
  });

  it("falls back to a generic message when the error body is unparseable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(unparseableResponse(422));

    const result = await requestInterviewPrep("vac-1", "tok", fetchImpl);

    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.message).toMatch(/could not be generated/i);
  });

  it("falls back to a generic message when the error body has no error string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422, { error: "   " }));

    const result = await requestInterviewPrep("vac-1", "tok", fetchImpl);

    expect(result.kind === "unavailable" && result.message).toMatch(/could not be generated/i);
  });

  it("reports a network failure as error, never as unavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    expect(await requestInterviewPrep("vac-1", "tok", fetchImpl)).toEqual({
      kind: "error",
      message: "Network error contacting the server.",
    });
  });

  it("reports an unparseable success body as error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(unparseableResponse(200));

    expect((await requestInterviewPrep("vac-1", "tok", fetchImpl)).kind).toBe("error");
  });
});

describe("interview prep session cache", () => {
  it("returns undefined for a vacancy that was never generated", () => {
    expect(getCachedInterviewPrep("vac-never")).toBeUndefined();
  });

  it("round-trips a prep by vacancy id", () => {
    setCachedInterviewPrep("vac-1", PREP);

    expect(getCachedInterviewPrep("vac-1")).toEqual(PREP);
  });

  it("keys by vacancy id, so one vacancy's prep never answers for another", () => {
    setCachedInterviewPrep("vac-1", PREP);

    expect(getCachedInterviewPrep("vac-2")).toBeUndefined();
  });

  it("overwrites on regenerate rather than keeping the stale prep", () => {
    setCachedInterviewPrep("vac-1", PREP);
    const regenerated = { ...PREP, gaps: [] };
    setCachedInterviewPrep("vac-1", regenerated);

    expect(getCachedInterviewPrep("vac-1")).toEqual(regenerated);
  });

  it("clears every entry", () => {
    setCachedInterviewPrep("vac-1", PREP);
    setCachedInterviewPrep("vac-2", PREP);

    clearInterviewPrepCache();

    expect(getCachedInterviewPrep("vac-1")).toBeUndefined();
    expect(getCachedInterviewPrep("vac-2")).toBeUndefined();
  });
});
