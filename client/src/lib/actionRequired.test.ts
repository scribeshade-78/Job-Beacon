import { describe, expect, it, vi } from "vitest";
import { listActionRequiredEvents } from "./actionRequired";

function createClient(response: { data: unknown; error: { message: string } | null }) {
  const order = vi.fn().mockResolvedValue(response);
  const is = vi.fn(() => ({ order }));
  const select = vi.fn(() => ({ is }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as Parameters<typeof listActionRequiredEvents>[0], from, select, is, order };
}

describe("listActionRequiredEvents", () => {
  it("maps rows with the joined vacancy on success", async () => {
    const { client, from, is } = createClient({
      data: [
        {
          id: "event-1",
          exception_type: "captcha",
          payload: { hint: "solve at portal" },
          expires_at: "2026-08-19T00:00:00Z",
          created_at: "2026-08-18T00:00:00Z",
          application_attempts: {
            application_plans: {
              vacancies: { raw_title: "Backend Engineer", authoritative_url: "https://example.com/jobs/1" },
            },
          },
        },
      ],
      error: null,
    });

    const result = await listActionRequiredEvents(client);

    expect(result).toEqual({
      kind: "success",
      events: [
        {
          id: "event-1",
          exceptionType: "captcha",
          payload: { hint: "solve at portal" },
          expiresAt: "2026-08-19T00:00:00Z",
          createdAt: "2026-08-18T00:00:00Z",
          vacancyTitle: "Backend Engineer",
          vacancyUrl: "https://example.com/jobs/1",
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("action_required_events");
    expect(is).toHaveBeenCalledWith("resolved_at", null);
  });

  it("falls back to empty vacancy fields when a join in the chain returns null", async () => {
    const { client } = createClient({
      data: [
        {
          id: "event-2",
          exception_type: "unsupported_portal",
          payload: {},
          expires_at: null,
          created_at: "2026-08-18T00:00:00Z",
          application_attempts: null,
        },
      ],
      error: null,
    });

    const result = await listActionRequiredEvents(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.events[0].vacancyTitle).toBe("");
      expect(result.events[0].vacancyUrl).toBe("");
    }
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const { client } = createClient({ data: null, error: { message: "relation does not exist" } });

    const result = await listActionRequiredEvents(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listActionRequiredEvents>[0];

    const result = await listActionRequiredEvents(client);

    expect(result).toEqual({
      kind: "error",
      message: "Could not load items needing your action. Please try again.",
    });
  });
});
