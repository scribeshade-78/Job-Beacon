import type { SupabaseClient } from "@supabase/supabase-js";

export type ConfirmationStatus = "pending" | "confirmed" | "rejected";

const GENERIC_FAILURE_MESSAGE = "Could not update this fact. Please try again.";

export type FactConfirmationWriteResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * Every write here targets fact_confirmations only — extracted_facts is
 * never touched by candidate action (it's the extraction provenance
 * record, per fact_confirmations_rls.test.sql's own assertion). The target
 * row is guaranteed to exist by the time a candidate can see it in the UI:
 * the extraction endpoint (service-role) creates the pending
 * fact_confirmations row for every fact at extraction time, since
 * candidates only have UPDATE (no INSERT) on this table.
 *
 * An UPDATE matching zero rows (wrong id, or RLS silently filtered someone
 * else's fact) resolves without error — same trap resume.ts's deleteResume
 * already documents — so `.select()` on the update is the only way to tell
 * "nothing matched" apart from "updated", checked the same way here.
 */
async function updateConfirmation(
  client: Pick<SupabaseClient, "from">,
  extractedFactId: string,
  patch: { status: ConfirmationStatus; corrected_value?: string },
): Promise<FactConfirmationWriteResult> {
  try {
    const { data, error } = await client
      .from("fact_confirmations")
      .update(patch)
      .eq("extracted_fact_id", extractedFactId)
      .select("extracted_fact_id");

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    if (!data || data.length === 0) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

/** Confirms a fact exactly as extracted — corrected_value is left untouched (stays null on a first confirm). */
export function confirmFact(
  client: Pick<SupabaseClient, "from">,
  extractedFactId: string,
): Promise<FactConfirmationWriteResult> {
  return updateConfirmation(client, extractedFactId, { status: "confirmed" });
}

/** A correction is confirmation-with-an-edit, not a separate unconfirmed state — see MP-F2's design note. */
export function correctFact(
  client: Pick<SupabaseClient, "from">,
  extractedFactId: string,
  correctedValue: string,
): Promise<FactConfirmationWriteResult> {
  return updateConfirmation(client, extractedFactId, { status: "confirmed", corrected_value: correctedValue });
}

export function rejectFact(
  client: Pick<SupabaseClient, "from">,
  extractedFactId: string,
): Promise<FactConfirmationWriteResult> {
  return updateConfirmation(client, extractedFactId, { status: "rejected" });
}

/** Un-confirm/un-reject — reopens a fact for review. No history is kept (the schema tracks only the current state). */
export function reopenFact(
  client: Pick<SupabaseClient, "from">,
  extractedFactId: string,
): Promise<FactConfirmationWriteResult> {
  return updateConfirmation(client, extractedFactId, { status: "pending" });
}

/**
 * Bulk "Confirm all" — one batched UPDATE for every currently-pending fact
 * id, not N sequential requests. Confirms as-extracted only (no bulk
 * correction — correcting is inherently a per-fact action).
 */
export async function confirmAllFacts(
  client: Pick<SupabaseClient, "from">,
  extractedFactIds: string[],
): Promise<FactConfirmationWriteResult> {
  if (extractedFactIds.length === 0) {
    return { kind: "success" };
  }

  try {
    const { error } = await client
      .from("fact_confirmations")
      .update({ status: "confirmed" })
      .in("extracted_fact_id", extractedFactIds);

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
