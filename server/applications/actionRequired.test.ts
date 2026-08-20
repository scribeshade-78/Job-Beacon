import { describe, expect, it, vi } from "vitest";
import { createActionRequiredEvent, resolveActionRequiredEvent } from "./actionRequired.js";

/**
 * R7-M15: resolveActionRequiredEvent now resolves candidate_id via
 * application_attempts -> application_plans before checking
 * automation_authorizations, so every test that reaches that point needs
 * fixtures for all three tables, not just action_required_events. The
 * application_attempts queue carries two entries in call order: the first
 * for isCandidateAuthorized's application_plan_id lookup, the second for
 * the actual status-transition update at the end.
 */
function authorizationCheckQueues(authorizationStatus: { status: string } | null) {
  return {
    application_attempts: [{ data: { application_plan_id: "plan-1" }, error: null }, { data: null, error: null }],
    application_plans: [{ data: { candidate_id: "candidate-1" }, error: null }],
    automation_authorizations: [{ data: authorizationStatus, error: null }],
  };
}

type TableResult = { data: unknown; error: unknown };

function chain(result: TableResult) {
  const builder: Record<string, unknown> & PromiseLike<TableResult> = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult>;
  return builder;
}

/** Each table's array of results is consumed one per `.from(table)` call, in order. */
function makeClient(queues: Partial<Record<string, TableResult[]>> = {}) {
  const remaining: Record<string, TableResult[]> = {
    action_required_events: [],
    application_attempts: [],
    ...queues,
  };
  const from = vi.fn((table: string) => {
    const queue = remaining[table];
    const result = queue && queue.length > 0 ? queue.shift()! : { data: null, error: null };
    return chain(result);
  });
  return { from } as unknown as Parameters<typeof createActionRequiredEvent>[0];
}

function callsFor(client: ReturnType<typeof makeClient>, table: string) {
  const from = client.from as unknown as ReturnType<typeof vi.fn>;
  return from.mock.results
    .filter((_r, i) => from.mock.calls[i][0] === table)
    .map((r) => r.value as ReturnType<typeof chain>);
}

const eventRow = {
  id: "event-1",
  application_attempt_id: "attempt-1",
  exception_type: "captcha",
  payload: { hint: "solve at portal" },
  expires_at: "2026-08-20T00:00:00Z",
  resolved_at: null,
  created_at: "2026-08-19T00:00:00Z",
};

describe("createActionRequiredEvent", () => {
  it("inserts an event row and marks the attempt action_required", async () => {
    const client = makeClient({
      action_required_events: [{ data: eventRow, error: null }],
      application_attempts: [{ data: null, error: null }],
    });

    const result = await createActionRequiredEvent(client, {
      applicationAttemptId: "attempt-1",
      exceptionType: "captcha",
      payload: { hint: "solve at portal" },
      expiresAt: "2026-08-20T00:00:00Z",
    });

    expect(result).toEqual({
      id: "event-1",
      applicationAttemptId: "attempt-1",
      exceptionType: "captcha",
      payload: { hint: "solve at portal" },
      expiresAt: "2026-08-20T00:00:00Z",
      resolvedAt: null,
      createdAt: "2026-08-19T00:00:00Z",
    });

    const [eventCall] = callsFor(client, "action_required_events");
    expect(eventCall.insert).toHaveBeenCalledWith({
      application_attempt_id: "attempt-1",
      exception_type: "captcha",
      payload: { hint: "solve at portal" },
      expires_at: "2026-08-20T00:00:00Z",
    });

    const [attemptCall] = callsFor(client, "application_attempts");
    expect(attemptCall.update).toHaveBeenCalledWith(expect.objectContaining({ status: "action_required" }));
    expect(attemptCall.eq).toHaveBeenCalledWith("id", "attempt-1");
  });

  it("defaults expiresAt to null when not given", async () => {
    const client = makeClient({
      action_required_events: [{ data: eventRow, error: null }],
      application_attempts: [{ data: null, error: null }],
    });

    await createActionRequiredEvent(client, {
      applicationAttemptId: "attempt-1",
      exceptionType: "unsupported_portal",
      payload: {},
    });

    const [eventCall] = callsFor(client, "action_required_events");
    expect(eventCall.insert).toHaveBeenCalledWith(expect.objectContaining({ expires_at: null }));
  });

  it("throws when the event insert fails", async () => {
    const client = makeClient({
      action_required_events: [{ data: null, error: { message: "db error" } }],
    });

    await expect(
      createActionRequiredEvent(client, { applicationAttemptId: "attempt-1", exceptionType: "captcha", payload: {} }),
    ).rejects.toBeTruthy();
  });

  it("throws when the event insert returns no data and no error", async () => {
    const client = makeClient({
      action_required_events: [{ data: null, error: null }],
    });

    await expect(
      createActionRequiredEvent(client, { applicationAttemptId: "attempt-1", exceptionType: "captcha", payload: {} }),
    ).rejects.toThrow(/Failed to insert/);
  });

  it("throws when the attempt status update fails", async () => {
    const client = makeClient({
      action_required_events: [{ data: eventRow, error: null }],
      application_attempts: [{ data: null, error: { message: "db error" } }],
    });

    await expect(
      createActionRequiredEvent(client, { applicationAttemptId: "attempt-1", exceptionType: "captcha", payload: {} }),
    ).rejects.toBeTruthy();
  });
});

describe("resolveActionRequiredEvent", () => {
  it("marks the event resolved and resumes the attempt to pending", async () => {
    const resolvedRow = { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" };
    const client = makeClient({
      // [0] the initial fetch (not yet resolved), [1] the update itself.
      action_required_events: [
        { data: eventRow, error: null },
        { data: resolvedRow, error: null },
      ],
      ...authorizationCheckQueues({ status: "authorized" }),
    });

    const result = await resolveActionRequiredEvent(client, { eventId: "event-1" });

    expect(result.resolvedAt).toBe("2026-08-19T01:00:00Z");
    expect(result.applicationAttemptId).toBe("attempt-1");

    const [fetchCall, updateCall] = callsFor(client, "action_required_events");
    expect(fetchCall.maybeSingle).toHaveBeenCalled();
    expect(updateCall.update).toHaveBeenCalledWith(expect.objectContaining({ resolved_at: expect.any(String) }));
    expect(updateCall.eq).toHaveBeenCalledWith("id", "event-1");

    const [, attemptCall] = callsFor(client, "application_attempts");
    expect(attemptCall.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", leased_until: null }),
    );
  });

  it("scopes the attempt-resume update to status = 'action_required', so it cannot resume an attempt that has already moved on", async () => {
    const client = makeClient({
      action_required_events: [
        { data: eventRow, error: null },
        { data: eventRow, error: null },
      ],
      ...authorizationCheckQueues({ status: "authorized" }),
    });

    await resolveActionRequiredEvent(client, { eventId: "event-1" });

    // application_attempts is queried twice now: [0] isCandidateAuthorized's
    // application_plan_id lookup, [1] the actual status-transition update —
    // the assertion below targets the latter.
    const [, attemptUpdateCall] = callsFor(client, "application_attempts");
    expect(attemptUpdateCall.eq).toHaveBeenNthCalledWith(1, "id", "attempt-1");
    expect(attemptUpdateCall.eq).toHaveBeenNthCalledWith(2, "status", "action_required");
  });

  it("is idempotent when the event is already resolved — returns the existing record unchanged, without touching resolved_at or the attempt", async () => {
    const alreadyResolvedRow = { ...eventRow, resolved_at: "2026-08-18T12:00:00Z" };
    const client = makeClient({
      action_required_events: [{ data: alreadyResolvedRow, error: null }],
    });

    const result = await resolveActionRequiredEvent(client, { eventId: "event-1" });

    expect(result.resolvedAt).toBe("2026-08-18T12:00:00Z");

    // Only the initial fetch happened — no second action_required_events
    // call to re-update resolved_at, and no application_attempts call at
    // all (the underlying attempt is not touched a second time).
    expect(callsFor(client, "action_required_events")).toHaveLength(1);
    expect(callsFor(client, "application_attempts")).toHaveLength(0);
  });

  it("throws when the event does not exist", async () => {
    const client = makeClient({
      action_required_events: [{ data: null, error: null }],
    });

    await expect(resolveActionRequiredEvent(client, { eventId: "missing" })).rejects.toThrow(/not found/);
  });

  it("throws when the initial event fetch errors", async () => {
    const client = makeClient({
      action_required_events: [{ data: null, error: { message: "db error" } }],
    });

    await expect(resolveActionRequiredEvent(client, { eventId: "event-1" })).rejects.toBeTruthy();
  });

  it("throws when the resolving update itself errors", async () => {
    const client = makeClient({
      action_required_events: [
        { data: eventRow, error: null },
        { data: null, error: { message: "db error" } },
      ],
    });

    await expect(resolveActionRequiredEvent(client, { eventId: "event-1" })).rejects.toBeTruthy();
  });

  it("throws when the attempt-resume update fails", async () => {
    const client = makeClient({
      action_required_events: [
        { data: eventRow, error: null },
        { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
      ],
      application_attempts: [
        { data: { application_plan_id: "plan-1" }, error: null }, // isCandidateAuthorized lookup succeeds
        { data: null, error: { message: "db error" } }, // the actual status-transition update fails
      ],
      application_plans: [{ data: { candidate_id: "candidate-1" }, error: null }],
      automation_authorizations: [{ data: { status: "authorized" }, error: null }],
    });

    await expect(resolveActionRequiredEvent(client, { eventId: "event-1" })).rejects.toBeTruthy();
  });

  describe("R7-M15: authorization recheck before resuming", () => {
    it("resumes to pending and queries automation_authorizations when the candidate is authorized", async () => {
      const client = makeClient({
        action_required_events: [
          { data: eventRow, error: null },
          { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
        ],
        ...authorizationCheckQueues({ status: "authorized" }),
      });

      await resolveActionRequiredEvent(client, { eventId: "event-1" });

      expect(callsFor(client, "automation_authorizations")).toHaveLength(1);
      const [, attemptUpdateCall] = callsFor(client, "application_attempts");
      expect(attemptUpdateCall.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "pending", leased_until: null }),
      );
    });

    it("cancels instead of resuming when the candidate is paused", async () => {
      const client = makeClient({
        action_required_events: [
          { data: eventRow, error: null },
          { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
        ],
        ...authorizationCheckQueues({ status: "paused" }),
      });

      await resolveActionRequiredEvent(client, { eventId: "event-1" });

      const [, attemptUpdateCall] = callsFor(client, "application_attempts");
      expect(attemptUpdateCall.update).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(attemptUpdateCall.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
    });

    it("cancels instead of resuming when the candidate is stopped", async () => {
      const client = makeClient({
        action_required_events: [
          { data: eventRow, error: null },
          { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
        ],
        ...authorizationCheckQueues({ status: "stopped" }),
      });

      await resolveActionRequiredEvent(client, { eventId: "event-1" });

      const [, attemptUpdateCall] = callsFor(client, "application_attempts");
      expect(attemptUpdateCall.update).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(attemptUpdateCall.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
    });

    it("cancels instead of resuming when no automation_authorizations row exists for the candidate", async () => {
      const client = makeClient({
        action_required_events: [
          { data: eventRow, error: null },
          { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
        ],
        ...authorizationCheckQueues(null),
      });

      await resolveActionRequiredEvent(client, { eventId: "event-1" });

      const [, attemptUpdateCall] = callsFor(client, "application_attempts");
      expect(attemptUpdateCall.update).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(attemptUpdateCall.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
    });

    it.each([
      ["paused", { status: "paused" }],
      ["stopped", { status: "stopped" }],
      ["missing authorization row", null],
    ])(
      "never resumes to pending when the candidate is not authorized (%s)",
      async (_label, authorizationStatus) => {
        const client = makeClient({
          action_required_events: [
            { data: eventRow, error: null },
            { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
          ],
          ...authorizationCheckQueues(authorizationStatus),
        });

        await resolveActionRequiredEvent(client, { eventId: "event-1" });

        const [, attemptUpdateCall] = callsFor(client, "application_attempts");
        const updateArg = (attemptUpdateCall.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
          status: string;
        };
        expect(updateArg.status).toBe("cancelled");
      },
    );

    it("does not touch application_evidence when the candidate is no longer authorized", async () => {
      const client = makeClient({
        action_required_events: [
          { data: eventRow, error: null },
          { data: { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" }, error: null },
        ],
        ...authorizationCheckQueues({ status: "paused" }),
      });

      await resolveActionRequiredEvent(client, { eventId: "event-1" });

      expect(callsFor(client, "application_evidence")).toHaveLength(0);
    });

    it("still marks the action_required_events row resolved even when the underlying attempt is cancelled, not resumed", async () => {
      const resolvedRow = { ...eventRow, resolved_at: "2026-08-19T01:00:00Z" };
      const client = makeClient({
        action_required_events: [
          { data: eventRow, error: null },
          { data: resolvedRow, error: null },
        ],
        ...authorizationCheckQueues({ status: "stopped" }),
      });

      const result = await resolveActionRequiredEvent(client, { eventId: "event-1" });

      expect(result.resolvedAt).toBe("2026-08-19T01:00:00Z");
      const [, eventResolveCall] = callsFor(client, "action_required_events");
      expect(eventResolveCall.update).toHaveBeenCalledWith(expect.objectContaining({ resolved_at: expect.any(String) }));
    });
  });
});
