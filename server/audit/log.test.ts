import { describe, expect, it, vi } from "vitest";
import {
  clampAuditLimit,
  DEFAULT_AUDIT_LIMIT,
  listAuditEvents,
  MAX_AUDIT_LIMIT,
} from "./log.js";

type Client = Parameters<typeof listAuditEvents>[0];

/** Chainable, thenable builder: every query method returns itself and awaiting it yields the result. */
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
    if (table !== "audit_events") {
      throw new Error("Unexpected table: " + table);
    }
    return builder;
  });

  return { client: { from } as unknown as Client, calls };
}

const sampleRow = {
  id: "a1",
  occurred_at: "2026-09-26T10:00:00.000Z",
  actor_id: "u1",
  actor_role: "admin",
  action: "role.granted",
  entity_type: "user_role",
  entity_id: "u2",
  summary: "Granted the admin role",
  reason: null,
  previous_values: null,
  new_values: { role: "admin" },
};

describe("clampAuditLimit", () => {
  it("defaults when absent or not a finite number", () => {
    expect(clampAuditLimit(undefined)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(Number.NaN)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(clampAuditLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_AUDIT_LIMIT);
  });

  it("clamps into range and truncates a fraction", () => {
    expect(clampAuditLimit(0)).toBe(1);
    expect(clampAuditLimit(-5)).toBe(1);
    expect(clampAuditLimit(12.9)).toBe(12);
    expect(clampAuditLimit(9999)).toBe(MAX_AUDIT_LIMIT);
    expect(clampAuditLimit(250)).toBe(250);
  });
});

describe("listAuditEvents", () => {
  it("maps rows and reports the applied window", async () => {
    const { client } = makeClient({ data: [sampleRow], error: null });

    await expect(listAuditEvents(client)).resolves.toEqual({
      events: [
        {
          id: "a1",
          occurredAt: "2026-09-26T10:00:00.000Z",
          actorId: "u1",
          actorRole: "admin",
          action: "role.granted",
          entityType: "user_role",
          entityId: "u2",
          summary: "Granted the admin role",
          reason: null,
          previousValues: null,
          newValues: { role: "admin" },
        },
      ],
      limit: DEFAULT_AUDIT_LIMIT,
      truncated: false,
    });
  });

  it("asks for one row beyond the limit so truncation is a fact, not a guess", async () => {
    const { client, calls } = makeClient({ data: [], error: null });

    await listAuditEvents(client, { limit: 50 });

    expect(calls).toContainEqual({ method: "order", args: ["occurred_at", { ascending: false }] });
    expect(calls).toContainEqual({ method: "limit", args: [51] });
  });

  it("drops the extra row and reports truncation when older rows exist", async () => {
    const { client } = makeClient({ data: [sampleRow, { ...sampleRow, id: "a2" }, { ...sampleRow, id: "a3" }], error: null });

    const result = await listAuditEvents(client, { limit: 2 });

    expect(result.truncated).toBe(true);
    expect(result.events.map((event) => event.id)).toEqual(["a1", "a2"]);
    expect(result.limit).toBe(2);
  });

  it("does not claim truncation when the table simply ended at the page size", async () => {
    const { client } = makeClient({ data: [sampleRow, { ...sampleRow, id: "a2" }], error: null });

    const result = await listAuditEvents(client, { limit: 2 });

    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(2);
  });

  it("returns an empty window rather than nulls", async () => {
    const { client } = makeClient({ data: null, error: null });

    await expect(listAuditEvents(client)).resolves.toEqual({
      events: [],
      limit: DEFAULT_AUDIT_LIMIT,
      truncated: false,
    });
  });

  it("throws when the query errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "db error" } });

    await expect(listAuditEvents(client)).rejects.toBeTruthy();
  });
});
