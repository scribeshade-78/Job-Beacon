import { describe, expect, it } from "vitest";
import { inspectEnv } from "./requiredEnv.js";

describe("inspectEnv", () => {
  it("is ok when every required key is present", () => {
    const report = inspectEnv({ SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(true);
    expect(report.requiredMissing).toEqual([]);
  });

  it("fails when a required key is absent", () => {
    const report = inspectEnv({ SUPABASE_URL: "https://x" } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(false);
    expect(report.requiredMissing).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("counts an EMPTY string as absent, because .env files carry bare NAME= lines", () => {
    // This is the case that would otherwise sail through: the NAME is already in
    // the environment, so both an "in" test and an "!== undefined" test report it
    // as configured while the value is empty and useless.
    const report = inspectEnv({
      SUPABASE_URL: "   ",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(false);
    expect(report.requiredMissing).toEqual(["SUPABASE_URL"]);
  });

  it("reports a missing feature key as optional rather than as a failure", () => {
    // Razorpay is absent by design until checkout is switched on. If that failed
    // the gate, every deploy would fail while the early-access path is in use, and
    // the gate would be disabled by hand.
    const report = inspectEnv({
      SUPABASE_URL: "https://x",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    } as NodeJS.ProcessEnv);

    expect(report.ok).toBe(true);
    expect(report.optionalMissing).toContain("RAZORPAY_KEY_ID");
  });

  it("NEVER emits a value - this payload is served unauthenticated", () => {
    const report = inspectEnv({
      SUPABASE_URL: "https://distinctive-host.example",
      SUPABASE_SERVICE_ROLE_KEY: "distinctive-secret-value",
    } as NodeJS.ProcessEnv);

    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain("distinctive-secret-value");
    expect(serialised).not.toContain("distinctive-host.example");
    expect(serialised).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
