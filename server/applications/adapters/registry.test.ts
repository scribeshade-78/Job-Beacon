import { describe, expect, it } from "vitest";
import { resolveApplicationAdapter } from "./registry.js";
import { unsupportedAdapter } from "./unsupportedAdapter.js";

describe("resolveApplicationAdapter", () => {
  it.each(["greenhouse", "lever", "adzuna", "usajobs", "some_future_source", ""])(
    "resolves source_code %j to unsupportedAdapter — no real per-source adapter is registered yet",
    (sourceCode) => {
      expect(resolveApplicationAdapter(sourceCode)).toBe(unsupportedAdapter);
    },
  );

  it("is deterministic: the same source_code always resolves to the same adapter reference", () => {
    const first = resolveApplicationAdapter("greenhouse");
    const second = resolveApplicationAdapter("greenhouse");
    expect(first).toBe(second);
  });

  it("the resolved fallback reports isAutomatedSubmissionSupported: false for any unregistered source_code (MP-A1)", () => {
    const adapter = resolveApplicationAdapter("greenhouse");
    expect(adapter.isAutomatedSubmissionSupported).toBe(false);
    expect(
      adapter.validateSupport({
        vacancy: { sourceCode: "greenhouse", trustStatus: "VERIFIED", rawTitle: "Backend Engineer" },
        candidateId: "candidate-1",
      }),
    ).toEqual({ supported: false, reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" });
  });
});
