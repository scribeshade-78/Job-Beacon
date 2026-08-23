import { describe, expect, it, vi } from "vitest";
import { confirmAllFacts, confirmFact, correctFact, rejectFact, reopenFact } from "./factConfirmations";

type TableResult = { data: unknown; error: unknown };

function makeClient(result: TableResult) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  const builder: Record<string, unknown> & PromiseLike<TableResult> = {
    update: record("update"),
    eq: record("eq"),
    in: record("in"),
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return Promise.resolve(result);
    },
    then: (onFulfilled: (value: TableResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  } as Record<string, unknown> & PromiseLike<TableResult>;
  const from = vi.fn(() => builder);
  return { client: { from } as unknown as Parameters<typeof confirmFact>[0], from, calls };
}

const FACT_ID = "fact-1";

describe("confirmFact", () => {
  it("updates only status, never touching corrected_value", async () => {
    const { client, calls } = makeClient({ data: [{ extracted_fact_id: FACT_ID }], error: null });

    const result = await confirmFact(client, FACT_ID);

    expect(result).toEqual({ kind: "success" });
    const updateCall = calls.find((call) => call.method === "update")!;
    expect(updateCall.args[0]).toEqual({ status: "confirmed" });
  });

  it("returns an error when the update matches zero rows", async () => {
    const { client } = makeClient({ data: [], error: null });

    const result = await confirmFact(client, FACT_ID);

    expect(result).toEqual({ kind: "error", message: "Could not update this fact. Please try again." });
  });

  it("returns an error when the update itself errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "db down" } });

    const result = await confirmFact(client, FACT_ID);

    expect(result.kind).toBe("error");
  });
});

describe("correctFact", () => {
  it("sets status to confirmed and writes the corrected value in the same update", async () => {
    const { client, calls } = makeClient({ data: [{ extracted_fact_id: FACT_ID }], error: null });

    const result = await correctFact(client, FACT_ID, "7 years");

    expect(result).toEqual({ kind: "success" });
    const updateCall = calls.find((call) => call.method === "update")!;
    expect(updateCall.args[0]).toEqual({ status: "confirmed", corrected_value: "7 years" });
  });
});

describe("rejectFact", () => {
  it("sets status to rejected", async () => {
    const { client, calls } = makeClient({ data: [{ extracted_fact_id: FACT_ID }], error: null });

    await rejectFact(client, FACT_ID);

    const updateCall = calls.find((call) => call.method === "update")!;
    expect(updateCall.args[0]).toEqual({ status: "rejected" });
  });
});

describe("reopenFact", () => {
  it("sets status back to pending", async () => {
    const { client, calls } = makeClient({ data: [{ extracted_fact_id: FACT_ID }], error: null });

    await reopenFact(client, FACT_ID);

    const updateCall = calls.find((call) => call.method === "update")!;
    expect(updateCall.args[0]).toEqual({ status: "pending" });
  });
});

describe("confirmAllFacts", () => {
  it("issues one batched update scoped to the given ids", async () => {
    const { client, calls } = makeClient({ data: null, error: null });

    const result = await confirmAllFacts(client, ["fact-1", "fact-2"]);

    expect(result).toEqual({ kind: "success" });
    expect(calls).toEqual([
      { method: "update", args: [{ status: "confirmed" }] },
      { method: "in", args: ["extracted_fact_id", ["fact-1", "fact-2"]] },
    ]);
  });

  it("is a no-op success when given an empty list, without calling the client at all", async () => {
    const { client, from } = makeClient({ data: null, error: null });

    const result = await confirmAllFacts(client, []);

    expect(result).toEqual({ kind: "success" });
    expect(from).not.toHaveBeenCalled();
  });

  it("returns an error when the batched update fails", async () => {
    const { client } = makeClient({ data: null, error: { message: "db down" } });

    const result = await confirmAllFacts(client, ["fact-1"]);

    expect(result.kind).toBe("error");
  });
});
