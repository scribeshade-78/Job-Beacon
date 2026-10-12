import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfirmedFactValues } from "../applications/adapters/localFixture.js";

/**
 * The profile fields the browser extension is allowed to type into a third party's form.
 *
 * DELIBERATELY THE SMALLEST USEFUL SET, and the list is a security boundary as much as
 * a type. Work authorisation, salary expectations, notice period and visa answers are
 * NOT here on purpose: those are questions a candidate should answer themselves on each
 * application rather than have broadcast automatically into an employer's system.
 */
export interface ExtensionProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinUrl: string;
}

/**
 * Splits a full name into the two boxes most forms have.
 *
 * FIRST TOKEN AS GIVEN NAME, THE REST AS FAMILY NAME. That is a convention, not a fact,
 * and for many naming traditions it is wrong - but the alternative (guessing which token
 * is a surname) is wrong more often and less predictably, and this at least never loses
 * a token. A form with a single "Full name" field is not served by this at all, which is
 * why the extension's content script does not claim to fill one.
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { firstName: "", lastName: "" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Builds the extension's payload from the candidate's CONFIRMED facts.
 *
 * REUSES loadConfirmedFactValues, which is the same reader the greenhouse and lever
 * submission adapters use. That matters more than the import path looks: it applies the
 * candidate's own corrections over the raw extraction, so a candidate who fixed "Jon" to
 * "Jonathan" gets "Jonathan" typed into an employer's form. It is also why this cannot
 * drift from what the server-side submission path would have sent.
 *
 * (The loader lives under applications/adapters/ for historical reasons and is imported
 * by two production adapters already; it is not a test helper. Moving it to a neutral
 * module would be tidier and is deliberately not bundled into this change.)
 *
 * EMPTY STRING MEANS "DO NOT TYPE ANYTHING", never null and never a placeholder. A null
 * becomes the literal word "null" in a naive filler, and "N/A" would be submitted to an
 * employer as an answer.
 *
 * linkedinUrl IS ALWAYS EMPTY, AND THAT IS NOT A BUG. Resume extraction writes
 * full_name, email, phone, location, current_title, years_of_experience and
 * most_recent_employer - there is no LinkedIn fact type anywhere in this system, so
 * inventing a value here would be fabrication. The field exists so the extension's
 * contract is stable if extraction ever captures one.
 */
export async function loadExtensionProfile(
  client: SupabaseClient,
  candidateId: string,
): Promise<ExtensionProfile> {
  const facts = await loadConfirmedFactValues(client, candidateId);
  const { firstName, lastName } = splitFullName(facts.get("full_name") ?? "");

  return {
    firstName,
    lastName,
    email: (facts.get("email") ?? "").trim(),
    phone: (facts.get("phone") ?? "").trim(),
    linkedinUrl: "",
  };
}
