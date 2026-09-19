import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_PREFERENCES,
  loadCandidatePreferences,
  parseListInput,
  saveCandidatePreferences,
  type CandidatePreferences,
} from "./candidatePreferences";

/**
 * Task I. The two behaviours worth pinning here are the ones a candidate would
 * feel: a salary floor cannot be saved without a currency (the table CHECK would
 * otherwise reject it with a message nobody can read), and "not stated" is not
 * collapsed into false.
 */

const ROW = {
  preferred_countries: ["India"],
  preferred_cities: ["Bengaluru"],
  remote_preference: "remote",
  employment_types: ["full_time"],
  work_authorization: "citizen",
  requires_sponsorship: null,
  min_salary: 80000,
  min_salary_currency: "USD",
  willing_to_relocate: null,
  excluded_companies: ["Acme"],
  excluded_industries: [],
};

function chain(value: { data: unknown; error: unknown }) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "upsert", "insert", "update"]) {
    node[method] = () => node;
  }
  node.single = async () => value;
  node.maybeSingle = async () => value;
  node.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  return node;
}

describe("parseListInput", () => {
  it("splits on commas and newlines and drops blanks", () => {
    expect(parseListInput("Acme, Globex\n Initech ,, ")).toEqual(["Acme", "Globex", "Initech"]);
  });

  it("returns nothing for an empty input", () => {
    expect(parseListInput("   ")).toEqual([]);
  });
});

describe("loadCandidatePreferences", () => {
  it("maps a row to the domain shape", async () => {
    const client = { from: () => chain({ data: ROW, error: null }) };

    const result = await loadCandidatePreferences(client as never, "cand-1");

    expect(result.kind).toBe("success");
    expect((result as { preferences: CandidatePreferences }).preferences).toMatchObject({
      preferredCountries: ["India"],
      remotePreference: "remote",
      minSalary: 80000,
      minSalaryCurrency: "USD",
      excludedCompanies: ["Acme"],
    });
  });

  it("returns null preferences when the candidate has never saved any", async () => {
    // null, not an empty object: "never set" must stay distinguishable from
    // "set to nothing", because only the first should be seeded from nothing.
    const client = { from: () => chain({ data: null, error: null }) };
    expect(await loadCandidatePreferences(client as never, "cand-1")).toEqual({
      kind: "success",
      preferences: null,
    });
  });

  it("keeps a null tri-state null rather than defaulting it to false", async () => {
    const client = { from: () => chain({ data: ROW, error: null }) };
    const result = await loadCandidatePreferences(client as never, "cand-1");
    const preferences = (result as { preferences: CandidatePreferences }).preferences;

    expect(preferences.requiresSponsorship).toBeNull();
    expect(preferences.willingToRelocate).toBeNull();
  });

  it("returns a generic error rather than throwing when the query fails", async () => {
    const client = { from: () => chain({ data: null, error: { message: "boom" } }) };
    const result = await loadCandidatePreferences(client as never, "cand-1");
    expect(result.kind).toBe("error");
    // Load failures say LOAD. Until Task I both paths shared one constant, so a
    // failed read told the candidate their preferences could not be saved.
    expect((result as { message: string }).message).toContain("load");
  });

  it("never surfaces the raw database message", async () => {
    const client = {
      from: () => {
        throw new Error("relation candidate_preferences does not exist");
      },
    };
    const result = await loadCandidatePreferences(client as never, "cand-1");

    expect(result.kind).toBe("error");
    expect(JSON.stringify(result)).not.toContain("does not exist");
  });
});

describe("saveCandidatePreferences", () => {
  it("upserts the whole preference set keyed on the candidate", async () => {
    const upsert = vi.fn(() => chain({ data: ROW, error: null }));
    const client = { from: () => ({ upsert }) };

    const result = await saveCandidatePreferences(client as never, "cand-1", EMPTY_PREFERENCES);

    expect(result.kind).toBe("success");
    const [payload, options] = (upsert as unknown as { mock: { calls: Array<[Record<string, unknown>, Record<string, unknown>]> } }).mock.calls[0];
    expect(payload.candidate_id).toBe("cand-1");
    expect(options).toEqual({ onConflict: "candidate_id" });
  });

  it("uppercases the currency", async () => {
    const upsert = vi.fn(() => chain({ data: ROW, error: null }));
    const client = { from: () => ({ upsert }) };

    await saveCandidatePreferences(client as never, "cand-1", {
      ...EMPTY_PREFERENCES,
      minSalary: 80000,
      minSalaryCurrency: "usd",
    });

    const payload = (upsert as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0][0];
    expect(payload.min_salary_currency).toBe("USD");
  });

  it("refuses a salary floor with no currency, with a readable reason", async () => {
    const upsert = vi.fn();
    const client = { from: () => ({ upsert }) };

    const result = await saveCandidatePreferences(client as never, "cand-1", {
      ...EMPTY_PREFERENCES,
      minSalary: 80000,
      minSalaryCurrency: null,
    });

    // The table CHECK refuses this combination; failing here means the candidate
    // reads a sentence instead of a constraint violation.
    expect(result).toEqual({ kind: "error", message: "Choose a currency for your minimum salary." });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a currency that is not three characters", async () => {
    const upsert = vi.fn();
    const client = { from: () => ({ upsert }) };

    const result = await saveCandidatePreferences(client as never, "cand-1", {
      ...EMPTY_PREFERENCES,
      minSalary: 80000,
      minSalaryCurrency: "DOLLARS",
    });

    expect(result.kind).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("allows a currency with no salary", async () => {
    const upsert = vi.fn(() => chain({ data: ROW, error: null }));
    const client = { from: () => ({ upsert }) };

    const result = await saveCandidatePreferences(client as never, "cand-1", {
      ...EMPTY_PREFERENCES,
      minSalaryCurrency: "USD",
    });

    expect(result.kind).toBe("success");
  });
});
