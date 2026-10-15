import { describe, expect, it } from "vitest";
import { INTEGRATIONS, listIntegrations, readEnvPresence } from "./integrations.js";

/**
 * Integration readiness is a READ-ONLY, presence-only view for the admin console.
 *
 * The one property that matters more than any other: a configured VALUE never leaves
 * the server. An admin console is a browser surface, and a key that reaches it has left
 * the server for good.
 */

describe("readEnvPresence", () => {
  it("reports a fully configured integration as configured, with nothing missing", () => {
    expect(readEnvPresence(["A", "B"], { A: "x", B: "y" })).toEqual({ configured: true, missingEnv: [] });
  });

  it("names exactly which variables are missing, in declaration order", () => {
    expect(readEnvPresence(["A", "B", "C"], { A: "x" })).toEqual({ configured: false, missingEnv: ["B", "C"] });
  });

  it("treats a blank or whitespace value as MISSING, not as configured", () => {
    // A key set to "" is the classic half-finished deployment: the app looks configured
    // and fails at the first request.
    expect(readEnvPresence(["A"], { A: "   " })).toEqual({ configured: false, missingEnv: ["A"] });
    expect(readEnvPresence(["A"], { A: "" })).toEqual({ configured: false, missingEnv: ["A"] });
    expect(readEnvPresence(["A"], {})).toEqual({ configured: false, missingEnv: ["A"] });
  });
});

function makeClient(opts: {
  policy?: unknown;
  policyError?: unknown;
  enabledCount?: number;
  countError?: unknown;
} = {}) {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;

      if (table === "source_policies") {
        builder.maybeSingle = async () => ({ data: opts.policy ?? null, error: opts.policyError ?? null });
      } else {
        builder.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ count: opts.enabledCount ?? 0, error: opts.countError ?? null }).then(resolve);
      }

      return builder;
    },
  } as never;
}

describe("listIntegrations", () => {
  it("reports presence plus the source's governance row and enabled-target count", async () => {
    const client = makeClient({
      policy: { discovery_allowed: true, kill_switch: false, policy_version: "adzuna-tou-review-pending" },
      enabledCount: 0,
    });

    const overview = await listIntegrations(client, { ADZUNA_APP_ID: "id", ADZUNA_APP_KEY: "key" });

    expect(overview.integrations).toHaveLength(1);
    expect(overview.integrations[0]).toMatchObject({
      id: "adzuna",
      configured: true,
      missingEnv: [],
      sourceCode: "adzuna",
      discoveryAllowed: true,
      killSwitch: false,
      policyVersion: "adzuna-tou-review-pending",
      enabledTargets: 0,
      requiresReview: true,
    });
  });

  it("NEVER returns a configured value — only names and booleans", async () => {
    const appKey = "super-secret-app-key-value";
    const appId = "the-application-id";
    const overview = await listIntegrations(makeClient(), { ADZUNA_APP_ID: appId, ADZUNA_APP_KEY: appKey });

    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain(appKey);
    expect(serialized).not.toContain(appId);
    expect(overview.integrations[0].configured).toBe(true);
  });

  it("reports NOT configured, and names the missing variable, when a key is absent", async () => {
    const overview = await listIntegrations(makeClient(), { ADZUNA_APP_ID: "id" });

    expect(overview.integrations[0].configured).toBe(false);
    expect(overview.integrations[0].missingEnv).toEqual(["ADZUNA_APP_KEY"]);
  });

  it("throws a real read failure rather than reporting 'not configured'", async () => {
    await expect(
      listIntegrations(makeClient({ policyError: { message: "db down" } }), {}),
    ).rejects.toBeTruthy();
  });

  it("declares the variables the Adzuna adapter actually reads", () => {
    // A definition that drifts from the adapter would report a false "Active".
    const adzuna = INTEGRATIONS.find((entry) => entry.id === "adzuna")!;
    expect(adzuna.requiredEnv).toEqual(["ADZUNA_APP_ID", "ADZUNA_APP_KEY"]);
    expect(adzuna.sourceCode).toBe("adzuna");
    expect(adzuna.requiresReview).toBe(true);
  });
});
