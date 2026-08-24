import { describe, expect, it } from "vitest";
import { unsupportedAdapter } from "./unsupportedAdapter.js";

describe("unsupportedAdapter", () => {
  it("rejects rather than returning a submission result — no fake success is possible", async () => {
    const client = {} as Parameters<typeof unsupportedAdapter.submit>[0];

    await expect(
      unsupportedAdapter.submit(client, { applicationAttemptId: "attempt-1", applicationPlanId: "plan-1" }),
    ).rejects.toThrow(/No application adapter is registered/);
  });

  it("includes the application attempt id in the error, for traceability", async () => {
    const client = {} as Parameters<typeof unsupportedAdapter.submit>[0];

    await expect(
      unsupportedAdapter.submit(client, { applicationAttemptId: "attempt-42", applicationPlanId: "plan-1" }),
    ).rejects.toThrow(/attempt-42/);
  });

  it("reports isAutomatedSubmissionSupported: false (MP-A1 capability model)", () => {
    expect(unsupportedAdapter.isAutomatedSubmissionSupported).toBe(false);
  });

  it("validateSupport always reports unsupported with the NO_ADAPTER_REGISTERED_FOR_SOURCE reason code, regardless of context", () => {
    const result = unsupportedAdapter.validateSupport({
      vacancy: { sourceCode: "greenhouse", trustStatus: "VERIFIED", rawTitle: "Backend Engineer" },
      candidateId: "candidate-1",
    });

    expect(result).toEqual({ supported: false, reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" });
  });
});
