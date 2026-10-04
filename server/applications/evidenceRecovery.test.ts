import { describe, expect, it, vi } from "vitest";

vi.mock("./submissionAdapter.js", () => ({
  submitApplicationAttempt: vi.fn(),
  ActionRequiredSubmissionError: class extends Error {},
  AuthorizationWithdrawnError: class extends Error {},
}));

import { submitApplicationAttempt } from "./submissionAdapter.js";
import { recoverAcceptedAttempts } from "./evidenceRecovery.js";

/**
 * Reconciliation is a LOCAL bookkeeping repair. These tests are mocked clients,
 * not database execution: the conditional update, its affected rows and the
 * shared evidence predicates are asserted as EMITTED, never as applied.
 */

interface AttemptRow {
  id: string;
  status: string;
}

interface EvidenceRow {
  application_attempt_id: string;
  evidence_type: string;
  payload: unknown;
  captured_at: string | null;
}

interface Config {
  attempts?: { data: unknown; error?: unknown };
  evidence?: { data: unknown; error?: unknown };
  updateResult?: { data: unknown; error?: unknown };
}

function makeClient(config: Config = {}) {
  const updates: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];

  const from = vi.fn((table: string) => {
    if (table === "application_attempts") {
      const filters: Array<[string, unknown]> = [];
      let payload: Record<string, unknown> | null = null;

      const builder: any = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        update: (next: Record<string, unknown>) => {
          payload = next;
          updates.push({ payload: next, filters });
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            payload === null ? (config.attempts ?? { data: [], error: null }) : (config.updateResult ?? { data: [{ id: "a1" }], error: null }),
          ).then(resolve),
      };
      return builder;
    }

    if (table === "application_evidence") {
      const builder: any = {
        select: () => builder,
        in: () => builder,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(config.evidence ?? { data: [], error: null }).then(resolve),
      };
      return builder;
    }

    throw new Error("unexpected table " + table);
  });

  return { client: { from } as never, updates };
}

const CONFIRMATION: EvidenceRow = {
  application_attempt_id: "a1",
  evidence_type: "submission_confirmation",
  payload: { adapterEvidenceType: "confirmation_id", confirmationId: "c1" },
  captured_at: "2026-10-01T10:00:00Z",
};

function submitting(id = "a1"): AttemptRow {
  return { id, status: "submitting" };
}

describe("recoverAcceptedAttempts", () => {
  it("finalizes an attempt with a trustworthy confirmation", async () => {
    const { client, updates } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
    });

    const result = await recoverAcceptedAttempts(client);

    expect(result.finalized).toBe(1);
    expect(result.skipped).toBe(0);
    expect(updates).toHaveLength(1);
    // The authoritative acceptance time, not the reconciliation time.
    expect(updates[0].payload.succeeded_at).toBe("2026-10-01T10:00:00Z");
    expect(updates[0].payload.status).toBe("succeeded");
  });

  it("is conditional on the status it read, so a concurrent change is not overwritten", async () => {
    const { client, updates } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
    });

    await recoverAcceptedAttempts(client);

    expect(updates[0].filters).toEqual([
      ["id", "a1"],
      ["status", "submitting"],
    ]);
  });

  it("skips, and does not overwrite, when the conditional update matches no row", async () => {
    const { client } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
      updateResult: { data: [], error: null },
    });

    const result = await recoverAcceptedAttempts(client);

    expect(result.finalized).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.outcomes[0].detail).toContain("Status changed");
  });

  it("leaves an attempt with no confirmation unresolved", async () => {
    const { client, updates } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [], error: null },
    });

    const result = await recoverAcceptedAttempts(client);

    expect(result.finalized).toBe(0);
    expect(result.skipped).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("leaves a malformed confirmation unresolved", async () => {
    const malformed = [
      { ...CONFIRMATION, payload: null },
      { ...CONFIRMATION, payload: {} },
      { ...CONFIRMATION, payload: { adapterEvidenceType: "confirmation_id" } },
      { ...CONFIRMATION, evidence_type: "submission_error" },
    ];

    for (const row of malformed) {
      const { client, updates } = makeClient({
        attempts: { data: [submitting()], error: null },
        evidence: { data: [row], error: null },
      });

      const result = await recoverAcceptedAttempts(client);

      expect(result.finalized).toBe(0);
      expect(updates).toHaveLength(0);
    }
  });

  it("does not apply another attempt's confirmation", async () => {
    const { client, updates } = makeClient({
      attempts: { data: [submitting("a2")], error: null },
      // a1 holds a valid confirmation; the unfinished attempt is a2.
      evidence: { data: [CONFIRMATION], error: null },
    });

    const result = await recoverAcceptedAttempts(client);

    expect(result.finalized).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("prefers the earliest captured confirmation when several exist", async () => {
    const later = { ...CONFIRMATION, captured_at: "2026-10-02T10:00:00Z" };
    const { client, updates } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [later, CONFIRMATION], error: null },
    });

    await recoverAcceptedAttempts(client);

    expect(updates[0].payload.succeeded_at).toBe("2026-10-01T10:00:00Z");
  });

  it("throws on a read error rather than reporting nothing to reconcile", async () => {
    const { client } = makeClient({
      attempts: { data: null, error: { message: "attempts unavailable" } },
    });

    await expect(recoverAcceptedAttempts(client)).rejects.toBeTruthy();
  });

  it("throws on an evidence read error", async () => {
    const { client } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: null, error: { message: "evidence unavailable" } },
    });

    await expect(recoverAcceptedAttempts(client)).rejects.toBeTruthy();
  });

  it("throws on an update error rather than reporting a finalization", async () => {
    const { client } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
      updateResult: { data: null, error: { message: "write failed" } },
    });

    await expect(recoverAcceptedAttempts(client)).rejects.toBeTruthy();
  });

  it("writes nothing in dry-run mode", async () => {
    const { client, updates } = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
    });

    const result = await recoverAcceptedAttempts(client, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.finalized).toBe(1);
    expect(result.outcomes[0].outcome).toBe("would_finalize");
    expect(updates).toHaveLength(0);
  });

  it("is harmless when repeated: a second run finds nothing left to finalize", async () => {
    const first = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
    });

    expect((await recoverAcceptedAttempts(first.client)).finalized).toBe(1);

    // The attempt is no longer 'submitting', so it is not even selected.
    const second = makeClient({ attempts: { data: [], error: null } });

    const result = await recoverAcceptedAttempts(second.client);

    expect(result.considered).toBe(0);
    expect(result.finalized).toBe(0);
  });

  it("never calls the submission adapter on any recovery path", async () => {
    const withConfirmation = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
    });
    const withoutConfirmation = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [], error: null },
    });
    const dryRun = makeClient({
      attempts: { data: [submitting()], error: null },
      evidence: { data: [CONFIRMATION], error: null },
    });

    await recoverAcceptedAttempts(withConfirmation.client);
    await recoverAcceptedAttempts(withoutConfirmation.client);
    await recoverAcceptedAttempts(dryRun.client, { dryRun: true });

    expect(submitApplicationAttempt).not.toHaveBeenCalled();
  });
});
