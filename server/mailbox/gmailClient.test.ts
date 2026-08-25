import { describe, expect, it, vi } from "vitest";
import { fetchMessageMetadata, GmailApiError, listRecentMessageIds } from "./gmailClient.js";
import type { FetchImpl } from "./oauth.js";

function mockFetch(response: Partial<Response> & { ok: boolean }): FetchImpl {
  return vi.fn(async () => response as Response);
}

describe("listRecentMessageIds", () => {
  it("queries in:inbox with the given time window and returns message ids", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: async () => ({ messages: [{ id: "msg-1" }, { id: "msg-2" }] }),
    });

    const ids = await listRecentMessageIds("at", 1700000000, fetchImpl);

    expect(ids).toEqual(["msg-1", "msg-2"]);
    const [calledUrl, calledInit] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("q=in%3Ainbox+after%3A1700000000");
    expect((calledInit.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("returns an empty list when Gmail returns no messages field", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({}) });
    expect(await listRecentMessageIds("at", 0, fetchImpl)).toEqual([]);
  });

  it("throws GmailApiError with the status on a non-ok response", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, json: async () => ({}) });
    await expect(listRecentMessageIds("at", 0, fetchImpl)).rejects.toMatchObject({ status: 401 });
    await expect(listRecentMessageIds("at", 0, fetchImpl)).rejects.toBeInstanceOf(GmailApiError);
  });
});

describe("fetchMessageMetadata", () => {
  it("requests format=metadata with From/Subject headers and parses them", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: async () => ({
        id: "msg-1",
        internalDate: "1700000000000",
        payload: {
          headers: [
            { name: "From", value: "recruiter@example.com" },
            { name: "Subject", value: "Re: Backend Engineer" },
          ],
        },
      }),
    });

    const metadata = await fetchMessageMetadata("at", "msg-1", fetchImpl);

    expect(metadata).toEqual({
      id: "msg-1",
      sender: "recruiter@example.com",
      subject: "Re: Backend Engineer",
      receivedAt: new Date(1700000000000).toISOString(),
      raw: expect.objectContaining({ id: "msg-1" }),
    });

    const [calledUrl] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(calledUrl).toContain("format=metadata");
    expect(calledUrl).not.toContain("format=full");
  });

  it("returns nulls for missing headers/date instead of throwing", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({ id: "msg-1", payload: {} }) });
    const metadata = await fetchMessageMetadata("at", "msg-1", fetchImpl);
    expect(metadata.sender).toBeNull();
    expect(metadata.subject).toBeNull();
    expect(metadata.receivedAt).toBeNull();
  });

  it("throws GmailApiError on a non-ok response", async () => {
    const fetchImpl = mockFetch({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchMessageMetadata("at", "msg-1", fetchImpl)).rejects.toBeInstanceOf(GmailApiError);
  });
});
