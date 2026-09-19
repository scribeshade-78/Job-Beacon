import { describe, expect, it } from "vitest";
import { resolveApplicationAdapter } from "./registry.js";
import { unsupportedAdapter } from "./unsupportedAdapter.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { localFixtureAdapter } from "./localFixture.js";

describe("resolveApplicationAdapter", () => {
  // lever was removed from this list by Task H3, which registered a real Lever
  // submission adapter; it moved to the registered table below.
  it.each(["adzuna", "usajobs", "jooble", "remotive", "some_future_source", ""])(
    "resolves source_code %j to unsupportedAdapter — no adapter is registered for it",
    (sourceCode) => {
      expect(resolveApplicationAdapter(sourceCode)).toBe(unsupportedAdapter);
    },
  );

  it.each([
    ["greenhouse", greenhouseAdapter],
    ["lever", leverAdapter],
    ["local_fixture", localFixtureAdapter],
  ] as const)("resolves the registered source_code %j to its own adapter", (sourceCode, expected) => {
    expect(resolveApplicationAdapter(sourceCode)).toBe(expected);
  });

  it("is deterministic: the same source_code always resolves to the same adapter reference", () => {
    for (const sourceCode of ["greenhouse", "local_fixture", "lever"]) {
      expect(resolveApplicationAdapter(sourceCode)).toBe(resolveApplicationAdapter(sourceCode));
    }
  });

  // Was written against "lever" as its example of an unregistered source. Task H3
  // registered a real Lever submission adapter, so lever is no longer that
  // example; usajobs is, and is a better one — it is a real configured source
  // that deliberately has no automated application channel at all.
  it("the fallback reports isAutomatedSubmissionSupported: false for any unregistered source_code (MP-A1)", () => {
    const adapter = resolveApplicationAdapter("usajobs");
    expect(adapter.isAutomatedSubmissionSupported).toBe(false);
    expect(
      adapter.validateSupport({
        vacancy: { sourceCode: "usajobs", trustStatus: "VERIFIED", rawTitle: "Backend Engineer" },
        candidateId: "candidate-1",
      }),
    ).toEqual({ supported: false, reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" });
  });

  it("a registered adapter passes application_support for its own source", () => {
    const adapter = resolveApplicationAdapter("greenhouse");
    expect(adapter.isAutomatedSubmissionSupported).toBe(true);
    expect(
      adapter.validateSupport({
        vacancy: { sourceCode: "greenhouse", trustStatus: "VERIFIED", rawTitle: "Backend Engineer" },
        candidateId: "candidate-1",
      }),
    ).toEqual({ supported: true });
  });
});
