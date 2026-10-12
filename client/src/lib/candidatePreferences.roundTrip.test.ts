import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  loadCandidatePreferences,
  saveCandidatePreferences,
  type CandidatePreferences,
} from "./candidatePreferences";

/**
 * A REAL ROUND TRIP, not one mapping asserted twice.
 *
 * The two functions are joined by an in-memory row that behaves like the table: save
 * writes into it, load reads out of it. Asserting the payload shape alone would prove
 * only that the write half is consistent with itself, and a mismatched column name on
 * the read half would still pass. Here a wrong name on EITHER side fails.
 */
function inMemoryClient() {
  let row: Record<string, unknown> | null = null;

  const client = {
    from: () => ({
      upsert: (payload: Record<string, unknown>) => {
        // The database echoes back the stored row, which is what .select().single()
        // returns in production - so the save path reads through the same shape.
        row = { ...payload };
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
      }),
    }),
  };

  return client as unknown as Pick<SupabaseClient, "from">;
}

function preferences(overrides: Partial<CandidatePreferences> = {}): CandidatePreferences {
  return {
    preferredCountries: [],
    preferredCities: [],
    remotePreference: null,
    employmentTypes: [],
    workAuthorization: null,
    requiresSponsorship: null,
    minSalary: null,
    minSalaryCurrency: null,
    willingToRelocate: null,
    excludedCompanies: [],
    excludedIndustries: [],
    openToAnyLocation: false,
    ...overrides,
  };
}

describe("relocation and sponsorship survive the save/load round trip", () => {
  it("persists true/false and reads back EXACTLY those values", async () => {
    const client = inMemoryClient();

    const saved = await saveCandidatePreferences(
      client,
      "candidate-1",
      preferences({ willingToRelocate: true, requiresSponsorship: false }),
    );
    expect(saved.kind).toBe("success");

    const loaded = await loadCandidatePreferences(client, "candidate-1");
    expect(loaded.kind).toBe("success");

    if (loaded.kind !== "success") {
      throw new Error("unreachable");
    }

    expect(loaded.preferences?.willingToRelocate).toBe(true);
    expect(loaded.preferences?.requiresSponsorship).toBe(false);
  });

  it("carries the OPPOSITE combination too, so neither field is reading the other", async () => {
    // Without this, a copy-paste that pointed both columns at one field would pass the
    // test above and silently record the wrong answer about visa sponsorship.
    const client = inMemoryClient();

    await saveCandidatePreferences(
      client,
      "candidate-1",
      preferences({ willingToRelocate: false, requiresSponsorship: true }),
    );

    const loaded = await loadCandidatePreferences(client, "candidate-1");

    expect(loaded.kind).toBe("success");
    if (loaded.kind !== "success") {
      throw new Error("unreachable");
    }

    expect(loaded.preferences?.willingToRelocate).toBe(false);
    expect(loaded.preferences?.requiresSponsorship).toBe(true);
  });

  it("keeps UNANSWERED as null, and never collapses it into false", async () => {
    // The columns are nullable on purpose: "not answered" and "answered no" are
    // different facts, and the visa gate reads them differently. A ?? false anywhere
    // in the mapping would turn every undeclared candidate into an explicit refusal.
    const client = inMemoryClient();

    await saveCandidatePreferences(
      client,
      "candidate-1",
      preferences({ willingToRelocate: null, requiresSponsorship: null }),
    );

    const loaded = await loadCandidatePreferences(client, "candidate-1");

    expect(loaded.kind).toBe("success");
    if (loaded.kind !== "success") {
      throw new Error("unreachable");
    }

    expect(loaded.preferences?.willingToRelocate).toBeNull();
    expect(loaded.preferences?.requiresSponsorship).toBeNull();
  });

  it("reads a LEGACY row, where the columns are absent rather than null", async () => {
    // Rows predating these columns come back with the keys MISSING, not set to null -
    // a different shape from an unanswered one. It must read as "not answered" rather
    // than crash or, worse, become false and look like an explicit refusal.
    const legacyRow = {
      candidate_id: "candidate-1",
      preferred_countries: [],
      preferred_cities: [],
      remote_preference: null,
      employment_types: [],
      work_authorization: null,
      min_salary: null,
      min_salary_currency: null,
      excluded_companies: [],
      excluded_industries: [],
      open_to_any_location: false,
    };

    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: legacyRow, error: null }) }) }),
      }),
    } as unknown as Pick<SupabaseClient, "from">;

    const loaded = await loadCandidatePreferences(client, "candidate-1");

    expect(loaded.kind).toBe("success");
    if (loaded.kind !== "success") {
      throw new Error("unreachable");
    }

    expect(loaded.preferences?.requiresSponsorship).toBeUndefined();
    expect(loaded.preferences?.willingToRelocate).toBeUndefined();
    // Undefined, NOT false: the panel renders this as an unanswered tri-state, so a
    // collapse here would show a candidate an answer they never gave.
    expect(loaded.preferences?.requiresSponsorship).not.toBe(false);
  });
});
