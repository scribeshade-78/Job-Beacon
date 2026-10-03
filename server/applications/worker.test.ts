import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./submissionAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./submissionAdapter.js")>();
  return { ...actual, submitApplicationAttempt: vi.fn() };
});
vi.mock("./actionRequired.js", () => ({ createActionRequiredEvent: vi.fn() }));

import { createActionRequiredEvent } from "./actionRequired.js";
import {
  ActionRequiredSubmissionError,
  AuthorizationWithdrawnError,
  submitApplicationAttempt,
} from "./submissionAdapter.js";
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
    // maybeSingle is what the pre-submission dismissal recheck uses for both
    // application_plans and dismissed_vacancies. Returning the table's own
    // result keeps an unconfigured table at its default (null = no row).
    maybeSingle: vi.fn(async () => result),
  };
  return builder;
}

function makeClient(overrides: {
  rpcResult?: { data: unknown; error: unknown };
  evidenceInsertResult?: { data: unknown; error: unknown };
  attemptUpdateResult?: { data: unknown; error: unknown };
  /** application_plans row the dismissal recheck reads, or null for "no plan". */
  planResult?: { data: unknown; error: unknown };
  /** dismissed_vacancies row, or null when the candidate has not dismissed it. */
  dismissalResult?: { data: unknown; error: unknown };
} = {}) {
  const rpc = vi.fn(async () => overrides.rpcResult ?? { data: [claimedAttempt], error: null });
  const from = vi.fn((table: string) => {
    if (table === "application_evidence") return chain(overrides.evidenceInsertResult ?? { data: null, error: null });
    if (table === "application_attempts") return chain(overrides.attemptUpdateResult ?? { data: null, error: null });
    if (table === "application_plans") return chain(overrides.planResult ?? { data: null, error: null });
    if (table === "dismissed_vacancies") return chain(overrides.dismissalResult ?? { data: null, error: null });
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

  describe("R7-M4: authorization withdrawn mid-flight", () => {
    it("marks the attempt cancelled and writes no application_evidence for a paused candidate", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new AuthorizationWithdrawnError("paused"));
      const client = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result).toEqual({ processed: true, applicationAttemptId: "attempt-1", outcome: "cancelled" });
      expect(client.from).not.toHaveBeenCalledWith("application_evidence");

      const attemptsTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
        (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_attempts",
      )!.value;
      expect(attemptsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      // No compensating decrement — this file's own claimedAttempt fixture already carries
      // attempts:1 from the (mocked) claim RPC, and update() is never called with an
      // "attempts" key at all for this outcome.
      expect(attemptsTable.update).not.toHaveBeenCalledWith(expect.objectContaining({ attempts: expect.anything() }));
    });

    it("does the same for a stopped candidate", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new AuthorizationWithdrawnError("stopped"));
      const client = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result).toEqual({ processed: true, applicationAttemptId: "attempt-1", outcome: "cancelled" });
    });

    it("does not take the exhausted/dead-letter path even when attempts already equals max_attempts", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new AuthorizationWithdrawnError("stopped"));
      const rpc = vi.fn(async () => ({
        data: [{ id: "attempt-3", application_plan_id: "plan-1", attempts: 5, max_attempts: 5 }],
        error: null,
      }));
      const from = vi.fn(() => chain({ data: null, error: null }));
      const client = { rpc, from } as unknown as Parameters<typeof runOneApplicationAttempt>[0];

      const result = await runOneApplicationAttempt(client);

      expect(result).toEqual({ processed: true, applicationAttemptId: "attempt-3", outcome: "cancelled" });

      const attemptsTable = (from as ReturnType<typeof vi.fn>).mock.results.find(
        (_r, i) => (from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_attempts",
      )!.value;
      expect(attemptsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(attemptsTable.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    });
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

  describe("pre-submission dismissal recheck", () => {
    // The spy is module-level and shared with the tests above, so each case here
    // starts from a clean call history.
    beforeEach(() => {
      vi.mocked(submitApplicationAttempt).mockClear();
    });

    it("cancels the attempt without submitting when the candidate dismissed the vacancy", async () => {
      const result = await runOneApplicationAttempt(
        makeClient({
          planResult: { data: { candidate_id: "candidate-1", vacancy_id: "vacancy-1" }, error: null },
          dismissalResult: { data: { vacancy_id: "vacancy-1" }, error: null },
        }),
      );

      expect(result).toEqual({
        processed: true,
        applicationAttemptId: "attempt-1",
        outcome: "cancelled",
      });
      // Nothing left the building: the adapter is never reached.
      expect(submitApplicationAttempt).not.toHaveBeenCalled();
    });

    it("marks a dismissed attempt cancelled, never failed", async () => {
      const client = makeClient({
        planResult: { data: { candidate_id: "candidate-1", vacancy_id: "vacancy-1" }, error: null },
        dismissalResult: { data: { vacancy_id: "vacancy-1" }, error: null },
      });

      await runOneApplicationAttempt(client);

      const attemptsTable = (client.from as ReturnType<typeof vi.fn>).mock.results.find(
        (_r, i) => (client.from as ReturnType<typeof vi.fn>).mock.calls[i][0] === "application_attempts",
      )!.value;
      expect(attemptsTable.update).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
      expect(attemptsTable.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    });

    it("submits normally when the plan's vacancy is not dismissed", async () => {
      vi.mocked(submitApplicationAttempt).mockResolvedValueOnce({
        evidenceType: "submission_confirmation",
        payload: { confirmationId: "x" },
      });

      const result = await runOneApplicationAttempt(
        makeClient({
          planResult: { data: { candidate_id: "candidate-1", vacancy_id: "vacancy-1" }, error: null },
          // No dismissed_vacancies row: the default null.
        }),
      );

      expect(result.outcome).toBe("succeeded");
      expect(submitApplicationAttempt).toHaveBeenCalled();
    });

    it("throws rather than calling a query error 'not dismissed'", async () => {
      await expect(
        runOneApplicationAttempt(
          makeClient({
            planResult: { data: { candidate_id: "candidate-1", vacancy_id: "vacancy-1" }, error: null },
            dismissalResult: { data: null, error: { message: "dismissed_vacancies unavailable" } },
          }),
        ),
      ).rejects.toBeTruthy();
    });
  });
});
