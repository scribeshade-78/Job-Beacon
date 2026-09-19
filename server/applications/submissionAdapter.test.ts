import { describe, expect, it, vi } from "vitest";
import { AuthorizationWithdrawnError, submitApplicationAttempt } from "./submissionAdapter.js";

type TableResult = { data: unknown; error: unknown };

function makeQueryBuilder(result: TableResult) {
  const builder: PromiseLike<TableResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    single: async () => result,
    maybeSingle: async () => result,
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as PromiseLike<TableResult> & Record<string, unknown>;
  return builder;
}

const DEFAULT_TABLE_RESULTS: Record<string, TableResult> = {
  application_plans: { data: { vacancy_id: "vacancy-1", candidate_id: "candidate-1" }, error: null },
  automation_authorizations: { data: { status: "authorized" }, error: null },
  // Task H3 registered real submission adapters for greenhouse and lever, so the
  // default vacancy now names a source that genuinely has no adapter — the
  // "unregistered source" case this file is about.
  vacancies: { data: { source_code: "usajobs" }, error: null },
};

function makeClient(overrides: Partial<Record<string, TableResult>> = {}) {
  const results = { ...DEFAULT_TABLE_RESULTS, ...overrides };
  const from = vi.fn((table: string) => {
    const result = results[table];
    if (!result) {
      throw new Error(`Unexpected table: ${table}`);
    }
    return makeQueryBuilder(result);
  });
  return { from } as unknown as Parameters<typeof submitApplicationAttempt>[0];
}

const baseContext = { applicationAttemptId: "attempt-1", applicationPlanId: "plan-1" };

describe("submitApplicationAttempt", () => {
  it("resolves the vacancy's source_code and dispatches to the (currently unsupported) adapter, which rejects — never a fabricated success", async () => {
    const client = makeClient();
    await expect(submitApplicationAttempt(client, baseContext)).rejects.toThrow(
      /No application adapter is registered/,
    );
  });

  it("throws when the application_plans row is not found", async () => {
    const client = makeClient({ application_plans: { data: null, error: null } });
    await expect(submitApplicationAttempt(client, baseContext)).rejects.toThrow(/application_plans row not found/);
  });

  it("propagates a database error from the application_plans lookup", async () => {
    const client = makeClient({ application_plans: { data: null, error: { message: "db error" } } });
    await expect(submitApplicationAttempt(client, baseContext)).rejects.toBeTruthy();
  });

  it("throws when the vacancies row is not found", async () => {
    const client = makeClient({ vacancies: { data: null, error: null } });
    await expect(submitApplicationAttempt(client, baseContext)).rejects.toThrow(/vacancies row not found/);
  });

  it("propagates a database error from the vacancies lookup", async () => {
    const client = makeClient({ vacancies: { data: null, error: { message: "db error" } } });
    await expect(submitApplicationAttempt(client, baseContext)).rejects.toBeTruthy();
  });

  it("resolves the same way for every source_code that has no registered adapter", async () => {
    for (const sourceCode of ["usajobs", "adzuna", "jooble", "remotive"]) {
      const client = makeClient({ vacancies: { data: { source_code: sourceCode }, error: null } });
      await expect(submitApplicationAttempt(client, baseContext)).rejects.toThrow(
        /No application adapter is registered/,
      );
    }
  });

  describe("R7-M4: automation authorization recheck", () => {
    it("proceeds to adapter resolution when the candidate is authorized", async () => {
      const client = makeClient();
      // Still rejects — via the unsupported adapter, not via AuthorizationWithdrawnError.
      await expect(submitApplicationAttempt(client, baseContext)).rejects.not.toBeInstanceOf(
        AuthorizationWithdrawnError,
      );
    });

    it("throws AuthorizationWithdrawnError, never reaching the adapter, when the candidate is paused", async () => {
      const client = makeClient({
        automation_authorizations: { data: { status: "paused" }, error: null },
        // If the adapter were reached, this would throw a different, adapter-specific error —
        // asserting the AuthorizationWithdrawnError type below proves it never got there.
      });
      const error = await submitApplicationAttempt(client, baseContext).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthorizationWithdrawnError);
      expect((error as AuthorizationWithdrawnError).status).toBe("paused");
    });

    it("throws AuthorizationWithdrawnError when the candidate is stopped", async () => {
      const client = makeClient({ automation_authorizations: { data: { status: "stopped" }, error: null } });
      const error = await submitApplicationAttempt(client, baseContext).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthorizationWithdrawnError);
      expect((error as AuthorizationWithdrawnError).status).toBe("stopped");
    });

    it("throws AuthorizationWithdrawnError when no automation_authorizations row exists at all", async () => {
      const client = makeClient({ automation_authorizations: { data: null, error: null } });
      const error = await submitApplicationAttempt(client, baseContext).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthorizationWithdrawnError);
      expect((error as AuthorizationWithdrawnError).status).toBe("not_yet_authorized");
    });

    it("propagates a database error from the automation_authorizations lookup", async () => {
      const client = makeClient({
        automation_authorizations: { data: null, error: { message: "db error" } },
      });
      await expect(submitApplicationAttempt(client, baseContext)).rejects.toBeTruthy();
    });

    it("never queries vacancies when authorization has been withdrawn (fails fast, before dispatch)", async () => {
      const client = makeClient({ automation_authorizations: { data: { status: "stopped" }, error: null } });
      await submitApplicationAttempt(client, baseContext).catch(() => undefined);
      expect(client.from).not.toHaveBeenCalledWith("vacancies");
    });
  });
});
