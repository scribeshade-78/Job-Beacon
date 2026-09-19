import { describe, expect, it, vi } from "vitest";
import { approveReviewedAttempt, requestAttemptPreview } from "./attemptReview";

const ATTEMPT_ID = "11111111-2222-4333-8444-555555555555";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Records the request so the tests can assert the URL and the bearer token. */
function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(status, body);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const token = async () => "session-token";

describe("requestAttemptPreview", () => {
  it("posts to the preview endpoint with the session token", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      applicationAttemptId: ATTEMPT_ID,
      previewUrl: "https://storage.test/x.pdf?token=t",
      previewUrlExpiresInSeconds: 300,
      resumePrepared: true,
      resume: { documentId: "doc-1", originalFilename: "r.pdf", tailored: true, optimizationLevel: "honest" },
    });

    const result = await requestAttemptPreview(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/attempts/" + ATTEMPT_ID + "/generate-preview");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer session-token");
    expect(result.kind).toBe("success");
  });

  it("percent-encodes the attempt id, so a crafted id cannot redirect the path", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {});

    await requestAttemptPreview("../../admin", { fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/attempts/..%2F..%2Fadmin/generate-preview");
  });

  it("reports an expired session rather than a generic failure on 401", async () => {
    const { fetchImpl } = recordingFetch(401, { error: "Unauthorized" });

    const result = await requestAttemptPreview(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("reports a missing session without making a request", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {});

    const result = await requestAttemptPreview(ATTEMPT_ID, { fetchImpl, getAccessToken: async () => null });

    expect(result.kind).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("says the application could not be found on 404", async () => {
    const { fetchImpl } = recordingFetch(404, { error: "Application attempt not found." });

    const result = await requestAttemptPreview(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    // The server answers 404 for both "no such attempt" and "not yours", so the
    // browser must not invent a distinction the API deliberately withholds.
    expect(result).toEqual({ kind: "error", message: "This application could not be found." });
  });

  it("reports a network failure without leaking the underlying error", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND internal-host");
    }) as unknown as typeof fetch;

    const result = await requestAttemptPreview(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });

  it("treats an unparseable success body as a failure rather than rendering nothing", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;

    const result = await requestAttemptPreview(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Could not prepare your resume preview. Please try again." });
  });
});

describe("approveReviewedAttempt", () => {
  it("posts to the approve endpoint with the session token", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { reviewApprovedAt: "2026-09-18T19:00:00.000Z" });

    const result = await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/attempts/" + ATTEMPT_ID + "/approve");
    expect(result).toEqual({ kind: "success", reviewApprovedAt: "2026-09-18T19:00:00.000Z" });
  });

  it("reports an expired session on 401", async () => {
    const { fetchImpl } = recordingFetch(401, { error: "Unauthorized" });

    const result = await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("advises generating the preview first when the server says the resume is missing", async () => {
    const { fetchImpl } = recordingFetch(409, {
      error: "Generate the resume preview before approving this application.",
    });

    const result = await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({
      kind: "error",
      message: "Create the resume preview before approving this application.",
    });
  });

  it("falls back to the generic conflict copy for any other 409", async () => {
    const { fetchImpl } = recordingFetch(409, {
      error: "This application is not awaiting your review.",
      status: "succeeded",
    });

    const result = await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "This application is no longer waiting for your review." });
  });

  it("refuses to report success without a timestamp from the server", async () => {
    const { fetchImpl } = recordingFetch(200, { status: "pending" });

    const result = await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    // A 200 with no reviewApprovedAt is not evidence the status changed, and
    // claiming success would tell the candidate something untrue.
    expect(result).toEqual({ kind: "error", message: "Could not approve this application. Please try again." });
  });

  it("reports a network failure", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    const result = await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });

  it("reports a session lookup failure without making a request", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {});

    const result = await approveReviewedAttempt(ATTEMPT_ID, {
      fetchImpl,
      getAccessToken: async () => {
        throw new Error("no session storage");
      },
    });

    expect(result).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
    expect(calls).toHaveLength(0);
  });

  it("never sends a body, so there is nothing for a caller to forge", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { reviewApprovedAt: "2026-09-18T19:00:00.000Z" });

    await approveReviewedAttempt(ATTEMPT_ID, { fetchImpl, getAccessToken: token });

    expect(calls[0].init?.body).toBeUndefined();
  });
});

describe("id validation is the server's job, not the browser's", () => {
  it("passes the id through and reports whatever the server decides", async () => {
    // Deliberately no client-side uuid check: the server validates the shape
    // and, more importantly, the ownership. A browser-side check would be
    // cosmetic — anyone can call the endpoint directly.
    const { fetchImpl, calls } = recordingFetch(400, { error: "id must be a valid application attempt id." });

    const result = await approveReviewedAttempt("not-a-uuid", { fetchImpl, getAccessToken: token });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/candidate/attempts/not-a-uuid/approve");
    expect(result.kind).toBe("error");
  });
});
