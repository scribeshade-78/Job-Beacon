import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadIntakeQueryContext } from "./queryContext.js";

type TableResult = { data: unknown; error?: unknown };

/**
 * A chainable, awaitable fake of the Supabase query builder.
 *
 * Awaitability is not decoration: this module awaits `.order(...)` and `.eq(...)`
 * directly for the list-shaped reads and calls `.maybeSingle()` for the
 * single-row one, so the fake has to support both shapes or the tests exercise a
 * path the real code never takes.
 */
function makeClient(tables: Record<string, TableResult>) {
  function builderFor(table: string) {
    const result = tables[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;

    for (const method of ["select", "eq", "in", "order", "limit"]) {
      builder[method] = chain;
    }

    builder.maybeSingle = () => Promise.resolve(result);
    builder.then = (resolve: (value: TableResult) => unknown) => resolve(result);

    return builder;
  }

  return { from: (table: string) => builderFor(table) } as unknown as Pick<SupabaseClient, "from">;
}

const CANDIDATE = "candidate-1";

function tables(over: Record<string, TableResult> = {}): Record<string, TableResult> {
  return {
    candidate_selected_roles: { data: [] },
    candidate_preferences: { data: null },
    extracted_facts: { data: [] },
    fact_confirmations: { data: [] },
    ...over,
  };
}

/** A confirmed location fact, the shape the two-step read produces. */
function withConfirmedLocation(location: string, corrected: string | null = null): Record<string, TableResult> {
  return tables({
    extracted_facts: { data: [{ id: "fact-1", fact_value: location }] },
    fact_confirmations: { data: [{ extracted_fact_id: "fact-1", corrected_value: corrected }] },
  });
}

function withPreferences(preferences: {
  preferred_cities?: string[];
  preferred_countries?: string[];
}): Record<string, TableResult> {
  return tables({
    candidate_preferences: {
      data: {
        preferred_cities: preferences.preferred_cities ?? [],
        preferred_countries: preferences.preferred_countries ?? [],
      },
    },
  });
}

describe("loadIntakeQueryContext — keywords", () => {
  it("joins every selected role into ONE comma-separated string", async () => {
    const client = makeClient(
      tables({
        candidate_selected_roles: {
          data: [{ role_name: "Data Engineer" }, { role_name: "Data Analyst" }],
        },
      }),
    );

    const context = await loadIntakeQueryContext(client, CANDIDATE);

    // One string, never an array: Jooble's free plan is a lifetime 500-request
    // budget, so the shape that would allow a per-role loop must not exist.
    expect(context.keywords).toBe("Data Engineer, Data Analyst");
  });

  it("returns undefined when the candidate has selected no roles", async () => {
    const context = await loadIntakeQueryContext(makeClient(tables()), CANDIDATE);

    expect(context.keywords).toBeUndefined();
  });

  it("skips blank role names rather than joining empty entries into the string", async () => {
    const client = makeClient(
      tables({
        candidate_selected_roles: { data: [{ role_name: "  " }, { role_name: "Data Engineer" }] },
      }),
    );

    expect((await loadIntakeQueryContext(client, CANDIDATE)).keywords).toBe("Data Engineer");
  });
});

describe("loadIntakeQueryContext — location fallback order", () => {
  it("uses the confirmed location fact when there is one", async () => {
    const context = await loadIntakeQueryContext(makeClient(withConfirmedLocation("Bengaluru")), CANDIDATE);

    expect(context.location).toBe("Bengaluru");
  });

  it("prefers corrected_value over the raw extracted value", async () => {
    const client = makeClient(withConfirmedLocation("Bangalore", "Bengaluru, India"));

    // Same rule generateResumePayload applies: a location the candidate
    // corrected must not be silently replaced by the raw extraction.
    expect((await loadIntakeQueryContext(client, CANDIDATE)).location).toBe("Bengaluru, India");
  });

  it("ignores an unconfirmed location fact", async () => {
    const client = makeClient(
      tables({
        extracted_facts: { data: [{ id: "fact-1", fact_value: "Bengaluru" }] },
        // No row for fact-1 means it was never confirmed.
        fact_confirmations: { data: [] },
      }),
    );

    expect((await loadIntakeQueryContext(client, CANDIDATE)).location).toBeUndefined();
  });

  it("falls back to the first preferred city when nothing is confirmed", async () => {
    const client = makeClient(withPreferences({ preferred_cities: ["Pune", "Mumbai"] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).location).toBe("Pune");
  });

  it("falls back to the first preferred country when there is no city", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["India", "Germany"] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).location).toBe("India");
  });

  it("lets a CONFIRMED fact outrank a stated preference", async () => {
    const client = makeClient({
      ...withConfirmedLocation("Bengaluru"),
      candidate_preferences: {
        data: { preferred_cities: ["Berlin"], preferred_countries: ["Germany"] },
      },
    });

    // The fact is where the candidate IS; the preference is where they would
    // like to be. Searching on the wish is how someone in Bengaluru is shown
    // Berlin jobs and concludes the feature is broken.
    expect((await loadIntakeQueryContext(client, CANDIDATE)).location).toBe("Bengaluru");
  });

  it("skips blank entries in the preference arrays", async () => {
    const client = makeClient(withPreferences({ preferred_cities: ["", "   ", "Pune"] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).location).toBe("Pune");
  });

  it("returns undefined when nothing at all is known", async () => {
    expect((await loadIntakeQueryContext(makeClient(tables()), CANDIDATE)).location).toBeUndefined();
  });
});

describe("loadIntakeQueryContext — country", () => {
  it("lower-cases a valid two-letter preference so Adzuna can use it directly", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["GB"] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).country).toBe("gb");
  });

  it("accepts an already-lower-case code", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["us"] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).country).toBe("us");
  });

  it("returns NO country for a country NAME rather than converting it", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["India"] }));

    // "India" is not "in". A guessed code silently selects the wrong national
    // market and returns plausible listings for the wrong country, so the
    // preference is refused and Adzuna is skipped with a reason instead.
    expect((await loadIntakeQueryContext(client, CANDIDATE)).country).toBeUndefined();
  });

  it("returns no country for a three-letter code", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["USA"] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).country).toBeUndefined();
  });

  it("returns no country for a blank preference", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["  "] }));

    expect((await loadIntakeQueryContext(client, CANDIDATE)).country).toBeUndefined();
  });

  it("reads only the FIRST preferred country, unlike the location fallback", async () => {
    const client = makeClient(withPreferences({ preferred_countries: ["India", "GB"] }));

    // First entry only, and India is a name — so no country is produced even
    // though a valid code sits behind it. Scanning forward would mean searching
    // a market the candidate listed second.
    expect((await loadIntakeQueryContext(client, CANDIDATE)).country).toBeUndefined();
  });
});

describe("loadIntakeQueryContext — failure handling", () => {
  it("still returns keywords when the candidate has no preferences row at all", async () => {
    const client = makeClient(
      tables({
        candidate_selected_roles: { data: [{ role_name: "Data Engineer" }] },
        candidate_preferences: { data: null },
      }),
    );

    const context = await loadIntakeQueryContext(client, CANDIDATE);

    expect(context).toEqual({ keywords: "Data Engineer", location: undefined, country: undefined });
  });

  it("propagates a database error rather than reporting it as an empty profile", async () => {
    const client = makeClient(
      tables({ candidate_selected_roles: { data: null, error: { message: "connection reset" } } }),
    );

    // A failed read is not "the candidate has no roles". Collapsing the two
    // would make a transient outage produce skip reasons that blame the
    // candidate's profile — false, and unactionable for them.
    await expect(loadIntakeQueryContext(client, CANDIDATE)).rejects.toBeDefined();
  });

  it("propagates a preference read failure too", async () => {
    const client = makeClient(
      tables({ candidate_preferences: { data: null, error: { message: "connection reset" } } }),
    );

    await expect(loadIntakeQueryContext(client, CANDIDATE)).rejects.toBeDefined();
  });

  it("propagates a fact read failure", async () => {
    const client = makeClient(tables({ extracted_facts: { data: null, error: { message: "boom" } } }));

    await expect(loadIntakeQueryContext(client, CANDIDATE)).rejects.toBeDefined();
  });
});
