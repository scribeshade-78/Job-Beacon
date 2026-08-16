import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateHardBlocks, type HardBlockSignals } from "./hardBlocks.js";

export interface ApplyHardBlocksResult {
  blocked: boolean;
  reasonCodes: string[];
}

const POLICY_VERSION = "r3-hard-block-v1";

/**
 * Evaluates the hard-block rules for one vacancy and, if any fire, records
 * a BLOCKED trust score, one vacancy_flags row per triggered reason code,
 * and updates vacancies.trust_status (PRD §12.2: "hard-block rules
 * override the numeric result"). Does nothing when no rule fires —
 * assigning a non-blocked trust_status (VERIFIED/UNDER_REVIEW/etc.) is the
 * weighted scorer's job (R3.3), not this function's.
 */
export async function applyHardBlocks(
  client: SupabaseClient,
  vacancyId: string,
  signals: HardBlockSignals,
): Promise<ApplyHardBlocksResult> {
  const reasonCodes = evaluateHardBlocks(signals);

  if (reasonCodes.length === 0) {
    return { blocked: false, reasonCodes: [] };
  }

  const { data: trustScore, error: scoreError } = await client
    .from("vacancy_trust_scores")
    .insert({
      vacancy_id: vacancyId,
      status: "BLOCKED",
      score: null,
      policy_version: POLICY_VERSION,
    })
    .select("id")
    .single();

  if (scoreError || !trustScore) {
    throw scoreError ?? new Error(`Failed to insert vacancy_trust_scores for vacancy ${vacancyId} — no row returned.`);
  }

  const { error: flagsError } = await client.from("vacancy_flags").insert(
    reasonCodes.map((reasonCode) => ({
      vacancy_trust_score_id: (trustScore as { id: string }).id,
      reason_code: reasonCode,
    })),
  );

  if (flagsError) {
    throw flagsError;
  }

  const { error: updateError } = await client
    .from("vacancies")
    .update({ trust_status: "BLOCKED" })
    .eq("id", vacancyId);

  if (updateError) {
    throw updateError;
  }

  return { blocked: true, reasonCodes };
}
