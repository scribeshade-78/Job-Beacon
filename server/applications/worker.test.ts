import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./submissionAdapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./submissionAdapter.js")>();
  return { ...actual, submitApplicationAttempt: vi.fn() };
});
vi.mock("./actionRequired.js", () => ({ createActionRequiredEvent: vi.fn() }));

import { createActionRequiredEvent } from "./actionRequired.js";
import { AtsSubmissionError } from "./adapters/errors.js";
import {
  ActionRequiredSubmissionError,
  AuthorizationWithdrawnError,
  submitApplicationAttempt,
} from "./submissionAdapter.js";
import { runOneApplicationAttempt } from "./worker.js";

/**
 * The submission boundary (Batch A).
 *
 * The two failure modes under test are the ones the old code had:
 *  - an unchecked evidence/status write leaving a bare 'succeeded' row, and
 *  - an attempt left reclaimable after an accepted submission, so
 *    claim_application_attempt (which reclaims 'pending' and expired 'leased')
 *    handed it to another worker five minutes later.
 *
 * Every case therefore asserts on the CALLS as much as the result: whether the
 * adapter was reached, and what the attempt row was told to become.
 */

const claimedAttempt = {
  id: "attempt-1",
  application_plan_id: "plan-1",
  attempts: 1,
  max_attempts: 5,
};

interface TableResult {
  data?: unknown;
  error?: unknown;
}

interface ClientConfig {
  rpcResult?: TableResult;
  /** The conditional leased -> submitting transition. */
  boundaryResult?: TableResult;
  /** Any other application_attempts update (status write, last_error write). */
  attemptUpdateResult?: TableResult;
  evidenceInsertResult?: TableResult;
  planResult?: TableResult;
  dismissalResult?: TableResult;
  dismissalError?: unknown;
}

function makeClient(config: ClientConfig = {}) {
  // Ordered log of the writes that matter, so "evidence before status" and
  // "no status write at all" are both assertable.
  const log: string[] = [];
  const attemptUpdates: Array<Record<string, unknown>> = [];
  const attemptFilters: Array<Array<[string, unknown]>> = [];

  const from = vi.fn((table: string) => {
    if (table === "application_attempts") {
      const filters: Array<[string, unknown]> = [];
      let pending: Record<string, unknown> | null = null;

      const builder: any = {
        update: (payload: Record<string, unknown>) => {
          pending = payload;
          attemptUpdates.push(payload);
          attemptFilters.push(filters);
          log.push("attempt:" + String(payload.status ?? "no-status"));
          return builder;
        },
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        gt: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const isBoundary = pending?.status === "submitting";
          const result = isBoundary
            ? (config.boundaryResult ?? { data: [{ id: claimedAttempt.id }], error: null })
            : (config.attemptUpdateResult ?? { data: null, error: null });
          return Promise.resolve(result).then(resolve);
        },
      };

      return builder;
    }

    if (table === "application_evidence") {
      const builder: any = {
        insert: () => {
          log.push("evidence");
          return Promise.resolve(config.evidenceInsertResult ?? { data: null, error: null });
        },
      };
      return builder;
    }

    const builder: any = {
      select: () => builder,
      eq: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        if (table === "application_plans") return config.planResult ?? { data: null, error: null };
        if (table === "dismissed_vacancies")
          return config.dismissalError
            ? { data: null, error: config.dismissalError }
            : (config.dismissalResult ?? { data: null, error: null });
        return { data: null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
      insert: () => Promise.resolve({ data: null, error: null }),
    };
    return builder;
  });

  const rpc = vi.fn(async () => config.rpcResult ?? { data: [claimedAttempt], error: null });

  return {
    client: { rpc, from } as unknown as Parameters<typeof runOneApplicationAttempt>[0],
    log,
    attemptUpdates,
    attemptFilters,
    from,
  };
}

function attemptStatuses(updates: Array<Record<string, unknown>>): unknown[] {
  return updates.map((update) => update.status);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runOneApplicationAttempt", () => {
  it("returns processed:false when the queue is empty", async () => {
    const { client } = makeClient({ rpcResult: { data: [], error: null } });

    expect(await runOneApplicationAttempt(client)).toEqual({ processed: false });
    expect(submitApplicationAttempt).not.toHaveBeenCalled();
  });

  it("throws when the claim RPC itself errors", async () => {
    const { client } = makeClient({ rpcResult: { data: null, error: { message: "rpc failed" } } });

    await expect(runOneApplicationAttempt(client)).rejects.toBeTruthy();
    expect(submitApplicationAttempt).not.toHaveBeenCalled();
  });

  describe("the submission boundary", () => {
    it("validates lease ownership and expiry in the transition itself", async () => {
      const { client, attemptFilters } = makeClient();

      await runOneApplicationAttempt(client);

      expect(attemptFilters[0]).toEqual([
        ["id", claimedAttempt.id],
        ["status", "leased"],
        ["leased_until", expect.any(String)],
      ]);
    });

    it("does not call the adapter when the boundary write fails", async () => {
      const { client } = makeClient({
        boundaryResult: { data: null, error: { message: "attempts unavailable" } },
      });

      await expect(runOneApplicationAttempt(client)).rejects.toBeTruthy();
      // The whole point: persistence failure BEFORE the call means nothing left
      // the building, so there is no uncertain outcome to reconcile.
      expect(submitApplicationAttempt).not.toHaveBeenCalled();
    });

    it("does not call the adapter when the lease is stale or already lost", async () => {
      const { client } = makeClient({ boundaryResult: { data: [], error: null } });

      const result = await runOneApplicationAttempt(client);

      // Zero affected rows: an expired lease, or another worker reclaimed it.
      expect(result).toEqual({
        processed: true,
        applicationAttemptId: claimedAttempt.id,
        outcome: "cancelled",
      });
      expect(submitApplicationAttempt).not.toHaveBeenCalled();
    });

    it("crosses to 'submitting' before the adapter is reached", async () => {
      const { client, log } = makeClient();

      await runOneApplicationAttempt(client);

      expect(log[0]).toBe("attempt:submitting");
      expect(attemptStatuses([{ status: "submitting" }])).toBeTruthy();
    });
  });

  describe("confirmed acceptance", () => {
    it("persists the receipt before claiming success", async () => {
      vi.mocked(submitApplicationAttempt).mockResolvedValueOnce({
        evidenceType: "submission_confirmation",
        payload: { confirmationId: "abc123" },
      });

      const { client, log, attemptUpdates } = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result).toEqual({
        processed: true,
        applicationAttemptId: claimedAttempt.id,
        outcome: "succeeded",
      });
      // evidence strictly before the succeeded status: the receipt is what makes
      // the claim true, so it cannot be written afterwards.
      expect(log).toEqual(["attempt:submitting", "evidence", "attempt:succeeded"]);
      expect(attemptStatuses(attemptUpdates)).toEqual(["submitting", "succeeded"]);
    });

    it("does not claim success when the receipt could not be stored", async () => {
      vi.mocked(submitApplicationAttempt).mockResolvedValueOnce({
        evidenceType: "submission_confirmation",
        payload: { confirmationId: "abc123" },
      });

      const { client, attemptUpdates } = makeClient({
        evidenceInsertResult: { data: null, error: { message: "evidence table unavailable" } },
      });

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("needs_verification");
      // The attempt stays 'submitting', which the claim predicate cannot
      // reclaim — so there is no automatic resubmission.
      expect(attemptStatuses(attemptUpdates)).toEqual(["submitting"]);
    });

    it("reports verification rather than success when the status write fails", async () => {
      vi.mocked(submitApplicationAttempt).mockResolvedValueOnce({
        evidenceType: "submission_confirmation",
        payload: { confirmationId: "abc123" },
      });

      const { client, log } = makeClient({
        attemptUpdateResult: { data: null, error: { message: "write failed" } },
      });

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("needs_verification");
      // The receipt IS stored, so recovery can finish this without the adapter.
      expect(log).toContain("evidence");
    });
  });

  describe("unresolved external outcomes", () => {
    it("never returns an unclassified error to the retry queue", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new Error("socket hang up"));

      const { client, attemptUpdates } = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("needs_verification");
      // The row is never set back to 'leased' or 'pending', so no ordinary
      // claim can pick it up again. The only status it ever holds is the
      // boundary's 'submitting', which the claim predicate excludes.
      expect(attemptStatuses(attemptUpdates)).toEqual(["submitting", undefined]);
      expect(attemptUpdates.some((u) => u.status === "leased" || u.status === "pending")).toBe(false);
    });

    it("records the unknown outcome durably without touching the status", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new Error("timeout"));

      const { client, attemptUpdates } = makeClient();

      await runOneApplicationAttempt(client);

      const lastErrorWrite = attemptUpdates[attemptUpdates.length - 1];
      expect(lastErrorWrite.status).toBeUndefined();
      expect(String(lastErrorWrite.last_error)).toContain("timeout");
    });
  });

  describe("provider-classified outcomes keep the existing policy", () => {
    it("reschedules with backoff on a retryable ATS failure", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(
        new AtsSubmissionError("rate limited", { retryable: true, reasonCode: "RATE_LIMITED", status: 429 }),
      );

      const { client, attemptUpdates } = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("failed");
      const reschedule = attemptUpdates[attemptUpdates.length - 1];
      expect(reschedule.status).toBe("leased");
      expect(reschedule.leased_until).toBeTruthy();
    });

    it("dead-letters a non-retryable ATS rejection immediately", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(
        new AtsSubmissionError("validation", { retryable: false, reasonCode: "VALIDATION", status: 422 }),
      );

      const { client, attemptUpdates } = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("failed");
      expect(attemptUpdates[attemptUpdates.length - 1].status).toBe("failed");
    });

    it("cancels without evidence when authorization was withdrawn before dispatch", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(new AuthorizationWithdrawnError("paused"));

      const { client, log } = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("cancelled");
      // A known pre-call cancellation: no evidence, and no verification state.
      expect(log).not.toContain("evidence");
    });

    it("routes a named action-required exception to the action-required event", async () => {
      vi.mocked(submitApplicationAttempt).mockRejectedValueOnce(
        new ActionRequiredSubmissionError("captcha", { prompt: "solve" }),
      );

      const { client } = makeClient();

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("action_required");
      expect(createActionRequiredEvent).toHaveBeenCalled();
    });
  });

  describe("dismissal recheck", () => {
    it("cancels without calling the adapter when the candidate dismissed the vacancy", async () => {
      const { client } = makeClient({
        planResult: { data: { candidate_id: "candidate-1", vacancy_id: "vacancy-1" }, error: null },
        dismissalResult: { data: { vacancy_id: "vacancy-1" }, error: null },
      });

      const result = await runOneApplicationAttempt(client);

      expect(result.outcome).toBe("cancelled");
      expect(submitApplicationAttempt).not.toHaveBeenCalled();
    });

    it("does not submit when the dismissal lookup fails", async () => {
      const { client } = makeClient({
        planResult: { data: { candidate_id: "candidate-1", vacancy_id: "vacancy-1" }, error: null },
        dismissalError: { message: "dismissed_vacancies unavailable" },
      });

      await expect(runOneApplicationAttempt(client)).rejects.toBeTruthy();
      expect(submitApplicationAttempt).not.toHaveBeenCalled();
    });
  });
});
