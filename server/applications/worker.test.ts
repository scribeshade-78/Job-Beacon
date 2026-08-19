import { describe, expect, it, vi } from "vitest";

vi.mock("./submissionAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./submissionAdapter.js")>();
  return { ...actual, submitApplicationAttempt: vi.fn() };
});
vi.mock("./actionRequired.js", () => ({ createActionRequiredEvent: vi.fn() }));

import { createActionRequiredEvent } from "./actionRequired.js";
import { ActionRequiredSubmissionError, submitApplicationAttempt } from "./submissionAdapter.js";
import { runOneApplicationAttempt } from "./worker.js";

const claimedAttempt = {
  id: "attempt-1",
  application_plan_id: "plan-1",
  attempts: 1,
  max_attempts: 5,
};

function chain(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    update: vi.fn(() => builder),
    insert: vi.fn(async () => result),
  };
  return builder;
}

function makeClient(overrides: {
  rpcResult?: { data: unknown; error: unknown };
  evidenceInsertResult?: { data: unknown; error: unknown };
  attemptUpdateResult?: { data: unknown; error: unknown };
} = {}) {
  const rpc = vi.fn(async () => overrides.rpcResult ?? { data: [claimedAttempt], error: null });
  const from = vi.fn((table: string) => {
    if (table === "application_evidence") return chain(overrides.evidenceInsertResult ?? { data: null, error: null });
    if (table === "application_attempts") return chain(overrides.attemptUpdateResult ?? { data: null, error: null });
    return chain({ data: null, error: null });
  });
  return { rpc, from } as unknown as Parameters<typeof runOneApplicationAttempt>[0];
}

describe("runOneApplicationAttempt", () => {
  it("returns processed:false when the queue is empty", async () => {
    const client = makeClient({ rpcResult: { data: [], error: null } });
    const result = await runOneApplicationAttempt(client);
    expect(result).toEqual({ processed: false });
  });

  it("throws when the claim RPC itself errors", async () => {
    const client = makeClient({ rpcResult: { data: null, error: { message: "rpc failed" } } });
    await expect(runOneApplicationAttempt(client)).rejects.toBeTruthy();
  });

  it("records evidence and marks the attempt succeeded on a successful submission", async () => {
    vi.mocked(submitApplicationAttempt).mockResolvedValueOnce({
      evidenceType: "submission_confirmation",
      payload: { confirmationId: "abc123" },
    });
    const client = makeClient();

    const result = await runOneApplicationAttempt(client);

    expect(result).toEqual({ processed: true, applicationAttemptId: "attempt-1", outcome: "succeeded" });

    const evidenceTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
      (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_evidence",
    )!.value;
    expect(evidenceTable.insert).toHaveBeenCalledWith({
      application_attempt_id: "attempt-1",
      evidence_type: "submission_confirmation",
      payload: { confirmationId: "abc123" },
    });

    const attemptsTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
      (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_attempts",
    )!.value;
    expect(attemptsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("records an error and reschedules with backoff when the submission fails and attempts remain", async () => {
    vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new Error("No submission adapter is registered"));
    const client = makeClient();

    const result = await runOneApplicationAttempt(client);

    expect(result).toEqual({
      processed: true,
      applicationAttemptId: "attempt-1",
      outcome: "failed",
      error: "No submission adapter is registered",
    });

    const evidenceTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
      (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_evidence",
    )!.value;
    expect(evidenceTable.insert).toHaveBeenCalledWith({
      application_attempt_id: "attempt-1",
      evidence_type: "submission_error",
      payload: { message: "No submission adapter is registered" },
    });

    const attemptsTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
      (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_attempts",
    )!.value;
    expect(attemptsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "leased", last_error: "No submission adapter is registered" }),
    );
  });

  it("routes a named exception to createActionRequiredEvent instead of the generic retry path", async () => {
    vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(
      new ActionRequiredSubmissionError("captcha", { hint: "solve at portal" }, "2026-08-20T00:00:00Z"),
    );
    vi.mocked(createActionRequiredEvent).mockResolvedValueOnce({
      id: "event-1",
      applicationAttemptId: "attempt-1",
      exceptionType: "captcha",
      payload: { hint: "solve at portal" },
      expiresAt: "2026-08-20T00:00:00Z",
      resolvedAt: null,
      createdAt: "2026-08-19T00:00:00Z",
    });
    const client = makeClient();

    const result = await runOneApplicationAttempt(client);

    expect(result).toEqual({ processed: true, applicationAttemptId: "attempt-1", outcome: "action_required" });

    expect(createActionRequiredEvent).toHaveBeenCalledWith(client, {
      applicationAttemptId: "attempt-1",
      exceptionType: "captcha",
      payload: { hint: "solve at portal" },
      expiresAt: "2026-08-20T00:00:00Z",
    });

    const evidenceTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
      (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_evidence",
    )!.value;
    expect(evidenceTable.insert).toHaveBeenCalledWith({
      application_attempt_id: "attempt-1",
      evidence_type: "action_required",
      payload: { exceptionType: "captcha", hint: "solve at portal" },
    });
  });

  it("propagates an error thrown by createActionRequiredEvent instead of swallowing it", async () => {
    vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(
      new ActionRequiredSubmissionError("otp_or_email_code", {}),
    );
    vi.mocked(createActionRequiredEvent).mockRejectedValueOnce(new Error("db error"));
    const client = makeClient();

    await expect(runOneApplicationAttempt(client)).rejects.toThrow("db error");
  });

  it("dead-letters (status: failed) once max_attempts is reached instead of rescheduling", async () => {
    vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new Error("still no adapter"));
    const rpc = vi.fn(async () => ({
      data: [{ id: "attempt-2", application_plan_id: "plan-1", attempts: 5, max_attempts: 5 }],
      error: null,
    }));
    const from = vi.fn(() => chain({ data: null, error: null }));
    const client = { rpc, from } as unknown as Parameters<typeof runOneApplicationAttempt>[0];

    const result = await runOneApplicationAttempt(client);

    expect(result).toEqual({
      processed: true,
      applicationAttemptId: "attempt-2",
      outcome: "failed",
      error: "still no adapter",
    });

    const attemptsTable = (from as ReturnType<typeof vi.fn>).mock.results.find(
      (_r, i) => (from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_attempts",
    )!.value;
    expect(attemptsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", last_error: "still no adapter" }),
    );
  });
});
