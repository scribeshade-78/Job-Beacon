import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadExtensionProfile, splitFullName } from "./profile.js";

/** A client whose extracted_facts/fact_confirmations reads return what we hand it. */
function clientWithFacts(
  facts: Array<{ id: string; fact_type: string; fact_value: string }>,
  confirmations: Array<{ extracted_fact_id: string; corrected_value: string | null }> = [],
): SupabaseClient {
  return {
    from: (table: string) => {
      const rows = table === "extracted_facts" ? facts : confirmations;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.in = chain;
      // Awaited directly, like the query builder is when the chain ends.
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
      return builder;
    },
  } as unknown as SupabaseClient;
}

const FACT = (id: string, type: string, value: string) => ({ id, fact_type: type, fact_value: value });

describe("splitFullName", () => {
  it("takes the first token as the given name and the rest as the family name", () => {
    expect(splitFullName("Siva Vishnu Teja")).toEqual({ firstName: "Siva", lastName: "Vishnu Teja" });
    expect(splitFullName("Ada Lovelace")).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("handles a single-word name rather than losing it", () => {
    expect(splitFullName("Prince")).toEqual({ firstName: "Prince", lastName: "" });
  });

  it("returns empty halves for a blank name rather than whitespace", () => {
    expect(splitFullName("   ")).toEqual({ firstName: "", lastName: "" });
    expect(splitFullName("")).toEqual({ firstName: "", lastName: "" });
  });
});

describe("loadExtensionProfile", () => {
  it("builds the extension's shape from the confirmed facts", async () => {
    const profile = await loadExtensionProfile(
      clientWithFacts(
        [
          FACT("f1", "full_name", "Siva Vishnu Teja"),
          FACT("f2", "email", "person@example.com"),
          FACT("f3", "phone", "+91 90000 00000"),
        ],
        // A CONFIRMATION ROW IS WHAT MAKES A FACT CONFIRMED. loadConfirmedFactValues
        // skips any fact with no confirmation row at all - so these are not decoration,
        // they are the difference between "extracted" and "the candidate agrees".
        [
          { extracted_fact_id: "f1", corrected_value: null },
          { extracted_fact_id: "f2", corrected_value: null },
          { extracted_fact_id: "f3", corrected_value: null },
        ],
      ),
      "candidate-1",
    );

    expect(profile).toEqual({
      firstName: "Siva",
      lastName: "Vishnu Teja",
      email: "person@example.com",
      phone: "+91 90000 00000",
      // NOT invented. Nothing in this system captures a LinkedIn URL - extraction writes
      // full_name, email, phone, location, current_title, years_of_experience and
      // most_recent_employer, and no more.
      linkedinUrl: "",
    });
  });

  it("prefers a CONFIRMED CORRECTION over the extracted value", async () => {
    // The candidate correcting "Jon" to "Jonathan" is the whole point of the
    // confirmation flow; serving the raw extraction would send the wrong name to an
    // employer on their behalf.
    const profile = await loadExtensionProfile(
      clientWithFacts(
        [FACT("f1", "full_name", "Jon Smith"), FACT("f2", "email", "old@example.com")],
        [
          { extracted_fact_id: "f1", corrected_value: null },
          // The candidate corrected the email; this is the value that must win.
          { extracted_fact_id: "f2", corrected_value: "new@example.com" },
        ],
      ),
      "candidate-1",
    );

    expect(profile.email).toBe("new@example.com");
    expect(profile.firstName).toBe("Jon");
  });

  it("returns empty strings for a candidate with no facts, never null or a placeholder", async () => {
    // THE FORM FILLER'S CONTRACT: an empty string means "do not type anything here".
    // A null would be typed as the word "null" by a naive filler, and a placeholder
    // like "N/A" would be submitted to an employer as an answer.
    const profile = await loadExtensionProfile(clientWithFacts([]), "candidate-1");

    expect(profile).toEqual({ firstName: "", lastName: "", email: "", phone: "", linkedinUrl: "" });
  });

  it("EXCLUDES an extracted fact the candidate has not confirmed", async () => {
    // The strongest guarantee this endpoint makes. An EMAIL row exists and is not
    // returned, because a confirmation row is what turns an extraction into an answer -
    // and typing an unconfirmed guess into an employer's form is the failure that
    // matters most here.
    const profile = await loadExtensionProfile(
      clientWithFacts(
        [FACT("f1", "full_name", "Ada Lovelace"), FACT("f2", "email", "unconfirmed@example.com")],
        [{ extracted_fact_id: "f1", corrected_value: null }],
      ),
      "candidate-1",
    );

    expect(profile.firstName).toBe("Ada");
    expect(profile.lastName).toBe("Lovelace");
    expect(profile.email).toBe("");
    expect(profile.phone).toBe("");
  });
});
