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
});
