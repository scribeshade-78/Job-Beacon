import { describe, expect, it, vi } from "vitest";
import {
  describeWait,
  dismissFollowUp,
  listPendingFollowUps,
  sendFollowUp,
  type PendingFollowUp,
} from "./followUps";

const DRAFT: PendingFollowUp = {
  draftId: "draft-1",
  applicationAttemptId: "attempt-1",
  companyName: "Acme",
  vacancyTitle: "Data Engineer III",
  vacancyUrl: "https://acme.test/jobs/3",
  daysSinceSubmission: 20,
  submittedAt: "2026-08-30T00:00:00.000Z",
  draftText: "Following up on my application.",
  generatedAt: "2026-09-18T22:00:00.000Z",
  modelVersion: "openai/gpt-4o-mini",
  promptVersion: "follow-up-v1",
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(status, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const token = async () => "session-token";

describe("listPendingFollowUps", () => {
  it("gets the pending list with the session token", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { followUps: [DRAFT] });

    const result = await listPendingFollowUps({ fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/follow-ups/pending");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer session-token");
    expect(result).toEqual({ kind: "success", followUps: [DRAFT] });
  });

  it("makes no request at all without a session", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { followUps: [] });

    const result = await listPendingFollowUps({ fetchImpl, getAccessToken: async () => null });

    expect(result.kind).toBe("error");
    expect(calls).toHaveLength(0);
  });

  it("treats a body without a followUps array as a failure, not as an empty list", async () => {
    // "You have no follow-ups" and "the response was not what we expected" look
    // identical to a defaulting client, and only one of them is true.
    const { fetchImpl } = recordingFetch(200, { error: "something else" });

    const result = await listPendingFollowUps({ fetchImpl, getAccessToken: token });

    expect(result.kind).toBe("error");
  });

  it("reports an expired session rather than a generic failure on 401", async () => {
    const { fetchImpl } = recordingFetch(401, { error: "Unauthorized" });

    const result = await listPendingFollowUps({ fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Your session has expired. Please sign in again." });
  });

  it("reports a network failure without leaking the underlying error", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND internal-host");
    }) as unknown as typeof fetch;

    const result = await listPendingFollowUps({ fetchImpl, getAccessToken: token });

    expect(result).toEqual({ kind: "error", message: "Network error contacting the server." });
  });
});

describe("sendFollowUp", () => {
  it("posts to the send endpoint for that draft", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      draftId: "draft-1",
      status: "sent",
      transmitted: false,
      note: "Marked as sent. No email was transmitted.",
    });

    await sendFollowUp("draft-1", { fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/follow-ups/draft-1/send");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("always reports transmitted false, whatever the server says", async () => {
    // The type says false because it cannot be true in this phase. A server
    // that claimed otherwise would be wrong, and this refuses to pass it on.
    const { fetchImpl } = recordingFetch(200, {
      draftId: "draft-1",
      status: "sent",
      transmitted: true,
      note: "Sent!",
    });

    const result = await sendFollowUp("draft-1", { fetchImpl, getAccessToken: token });

    expect(result).toMatchObject({ kind: "success", transmitted: false });
  });

  it("carries the server's note through, which is where the honesty lives", async () => {
    const { fetchImpl } = recordingFetch(200, {
      draftId: "draft-1",
      status: "sent",
      transmitted: false,
      note: "Marked as sent. No email was transmitted — delivery is not wired up yet.",
    });

    const result = await sendFollowUp("draft-1", { fetchImpl, getAccessToken: token });

    expect(result).toMatchObject({ note: expect.stringContaining("No email was transmitted") });
  });

  it("percent-encodes the draft id", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { draftId: "x", note: "n" });

    await sendFollowUp("../../admin", { fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/follow-ups/..%2F..%2Fadmin/send");
  });

  it("maps 404 and 409 to distinct copy", async () => {
    const notFound = await sendFollowUp("draft-1", {
      fetchImpl: recordingFetch(404, {}).fetchImpl,
      getAccessToken: token,
    });
    const conflict = await sendFollowUp("draft-1", {
      fetchImpl: recordingFetch(409, {}).fetchImpl,
      getAccessToken: token,
    });

    expect(notFound).toEqual({ kind: "error", message: "This follow-up could not be found." });
    expect(conflict).toEqual({
      kind: "error",
      message: "This follow-up is no longer awaiting your review.",
    });
  });

  it("refuses to report success without a draftId to prove it", async () => {
    const { fetchImpl } = recordingFetch(200, { note: "Marked as sent." });

    const result = await sendFollowUp("draft-1", { fetchImpl, getAccessToken: token });

    expect(result.kind).toBe("error");
  });
});

describe("dismissFollowUp", () => {
  it("posts to the dismiss endpoint", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { draftId: "draft-1", status: "dismissed" });

    const result = await dismissFollowUp("draft-1", { fetchImpl, getAccessToken: token });

    expect(calls[0].url).toBe("/api/candidate/follow-ups/draft-1/dismiss");
    expect(result).toEqual({ kind: "success", draftId: "draft-1", dismissed: true });
  });

  it("reports a conflict rather than pretending the dismissal worked", async () => {
    const { fetchImpl } = recordingFetch(409, {});

    const result = await dismissFollowUp("draft-1", { fetchImpl, getAccessToken: token });

    expect(result.kind).toBe("error");
  });
});

describe("describeWait", () => {
  it("uses days below a week and weeks from a week on", () => {
    expect(describeWait(1)).toBe("waiting 1 day");
    expect(describeWait(2)).toBe("waiting 2 days");
    expect(describeWait(6)).toBe("waiting 6 days");
    expect(describeWait(7)).toBe("waiting 1 week");
    expect(describeWait(13)).toBe("waiting 1 week");
    expect(describeWait(14)).toBe("waiting 2 weeks");
    expect(describeWait(20)).toBe("waiting 2 weeks");
  });

  it("reaches the seven-day case at all, which the previous rule did not", () => {
    // The weeks branch used to start at fourteen days, so "1 week" could never
    // be produced — the smallest value reaching it was 14, and floor(14/7) is 2.
    const produced = [1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 20, 60].map(describeWait);

    expect(produced).toContain("waiting 1 week");
    for (const phrase of produced) {
      expect(phrase).not.toContain("0 weeks");
      expect(phrase).not.toContain("undefined");
    }
  });

  it("handles the boundary cases without a nonsense phrase", () => {
    expect(describeWait(0)).toBe("applied today");
    expect(describeWait(-3)).toBe("applied today");
  });
});
