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
});
