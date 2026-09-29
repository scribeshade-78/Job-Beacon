import { describe, expect, it } from "vitest";
import { loadQueueCapability } from "./queueCapability.js";

/**
 * The capability is what stops the Copilot advertising an action that cannot
 * succeed, so its two halves are asserted directly rather than through a
 * component that happens to use it.
 *
 * greenhouse/lever/local_fixture have real adapters (adapters/registry.ts);
 * everything else resolves to unsupportedAdapter.
 */
function makeClient(tables: Record<string, unknown[] | { error: { message: string } }>) {
  return {
    from: (table: string) => {
      const entry = tables[table] ?? [];
      const result = Array.isArray(entry) ? { data: entry, error: null } : { data: null, error: entry.error };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["select", "eq", "in", "order", "limit"]) {
        builder[method] = chain;
      }

      builder.then = (resolve: (value: unknown) => unknown) => resolve(result);

      return builder;
    },
  } as never;
}

describe("loadQueueCapability", () => {
  it("is false when no vacancies exist at all", async () => {
    const capability = await loadQueueCapability(makeClient({ vacancies: [] }));

    expect(capability).toEqual({ canQueue: false, queueableSources: [] });
  });

  /**
   * THE PRODUCTION CASE. arbeitnow holds vacancies and its policy allows
   * automated application, but it has no submission adapter — so nothing can
   * queue, and the tool must be withheld.
   */
  it("is false when vacancies exist but the source has no adapter", async () => {
    const capability = await loadQueueCapability(
      makeClient({
        vacancies: [{ source_code: "arbeitnow" }],
        source_policies: [
          { source_code: "arbeitnow", discovery_allowed: true, automated_application_allowed: true },
        ],
      }),
    );

    expect(capability.canQueue).toBe(false);
  });

  it("is false when the adapter exists but the policy does not authorize it", async () => {
    const capability = await loadQueueCapability(
      makeClient({
        vacancies: [{ source_code: "greenhouse" }],
        source_policies: [
          { source_code: "greenhouse", discovery_allowed: true, automated_application_allowed: false },
        ],
      }),
    );

    expect(capability.canQueue).toBe(false);
  });

  it("is false when the policy row is missing entirely", async () => {
    const capability = await loadQueueCapability(
      makeClient({ vacancies: [{ source_code: "greenhouse" }], source_policies: [] }),
    );

    expect(capability.canQueue).toBe(false);
  });

  it("is true only when an adapter and an authorizing policy both exist", async () => {
    const capability = await loadQueueCapability(
      makeClient({
        vacancies: [{ source_code: "greenhouse" }],
        source_policies: [
          { source_code: "greenhouse", discovery_allowed: true, automated_application_allowed: true },
        ],
      }),
    );

    expect(capability).toEqual({ canQueue: true, queueableSources: ["greenhouse"] });
  });

  it("ignores an authorized adapter for a source holding no vacancies", async () => {
    // A registered channel with nothing to send cannot queue anything, and
    // counting it would advertise a tool that still ends at "0 queued".
    const capability = await loadQueueCapability(
      makeClient({
        vacancies: [{ source_code: "arbeitnow" }],
        source_policies: [
          { source_code: "greenhouse", discovery_allowed: true, automated_application_allowed: true },
          { source_code: "arbeitnow", discovery_allowed: true, automated_application_allowed: true },
        ],
      }),
    );

    expect(capability.canQueue).toBe(false);
  });

  it("returns not-possible on a query failure rather than throwing", async () => {
    const capability = await loadQueueCapability(
      makeClient({ vacancies: { error: { message: "PostgREST unreachable" } } }),
    );

    expect(capability).toEqual({ canQueue: false, queueableSources: [] });
  });
});
