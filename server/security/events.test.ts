import { describe, expect, it, vi } from "vitest";
import {
  clampSecurityEventLimit,
  DEFAULT_SECURITY_EVENT_LIMIT,
  listSecurityEvents,
  MAX_SECURITY_EVENT_LIMIT,
  recordSecurityEvent,
} from "./events.js";

type Client = Parameters<typeof listSecurityEvents>[0];

function makeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const chain = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };

  builder.select = chain("select");
  builder.order = chain("order");
  builder.limit = chain("limit");
  builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);

  const from = vi.fn((table: string) => {
    if (table !== "security_events") {
      throw new Error("Unexpected table: " + table);
    }
    return builder;
  });

  return { client: { from } as unknown as Client, calls };
}

const sampleRow = {
  id: "s1",
  occurred_at: "2026-09-26T10:00:00.000Z",
  event_type: "prompt_injection_suspected",
  severity: "high",
  source: "email_body",
  subject_id: "m1",
  detail: { marker: "ignore previous instructions" },
};

describe("clampSecurityEventLimit", () => {
  it("defaults when absent or not a finite number", () => {
    expect(clampSecurityEventLimit(undefined)).toBe(DEFAULT_SECURITY_EVENT_LIMIT);
    expect(clampSecurityEventLimit(Number.NaN)).toBe(DEFAULT_SECURITY_EVENT_LIMIT);
    expect(clampSecurityEventLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SECURITY_EVENT_LIMIT);
  });

  it("clamps into range and truncates a fraction", () => {
    expect(clampSecurityEventLimit(0)).toBe(1);
    expect(clampSecurityEventLimit(-1)).toBe(1);
    expect(clampSecurityEventLimit(99.8)).toBe(99);
    expect(clampSecurityEventLimit(100000)).toBe(MAX_SECURITY_EVENT_LIMIT);
  });
});

describe("listSecurityEvents", () => {
  it("maps rows and reports the applied window", async () => {
    const { client } = makeClient({ data: [sampleRow], error: null });

    await expect(listSecurityEvents(client)).resolves.toEqual({
      events: [
        {
          id: "s1",
          occurredAt: "2026-09-26T10:00:00.000Z",
          eventType: "prompt_injection_suspected",
          severity: "high",
          source: "email_body",
          subjectId: "m1",
          detail: { marker: "ignore previous instructions" },
        },
      ],
      limit: DEFAULT_SECURITY_EVENT_LIMIT,
      truncated: false,
    });
  });

  it("asks for one row beyond the limit", async () => {
    const { client, calls } = makeClient({ data: [], error: null });

    await listSecurityEvents(client, { limit: 250 });

    expect(calls).toContainEqual({ method: "limit", args: [251] });
  });

  it("reports truncation and drops the extra row when older rows exist", async () => {
    const { client } = makeClient({ data: [sampleRow, { ...sampleRow, id: "s2" }], error: null });

    const result = await listSecurityEvents(client, { limit: 1 });

    expect(result.truncated).toBe(true);
    expect(result.events.map((event) => event.id)).toEqual(["s1"]);
  });

  it("throws when the query errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "db error" } });

    await expect(listSecurityEvents(client)).rejects.toBeTruthy();
  });
});

describe("recordSecurityEvent", () => {
  it("never throws when the insert fails, because it sits on the classification path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      from: () => ({ insert: async () => ({ error: { message: "db down" } }) }),
    } as unknown as Parameters<typeof recordSecurityEvent>[0];

    await expect(
      recordSecurityEvent(client, { eventType: "script_tag_removed", severity: "low", source: "email_html" }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
