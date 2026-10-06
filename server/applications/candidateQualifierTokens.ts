import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { preferredQualifiers } from "../../shared/candidateQualifiers.js";
import { TOKENIZER_VERSION, evidenceFingerprint } from "../../shared/evidenceTokens.js";

/**
 * Derives a candidate's preference tokens from CONFIRMED saved intent, keeping
 * each qualifier attached to the canonical role it belongs to.
 *
 * WHY THIS IS SEPARATE FROM THE FEED. Ordering needs a set SQL can intersect; the
 * derivation needs the shared TS rule. This module is the boundary: TS derives,
 * SQL intersects. Nothing here matches postings — relevance remains the
 * authoritative shared rule elsewhere.
 *
 * LEGACY UNKNOWN INTENT DERIVES NOTHING. A selection with no recorded phrase
 * yields no rows, because there is no confirmed request to honour. A missing row
 * is "no recorded preference", never a guessed one.
 */

export interface SelectedRoleIntent {
  roleName: string;
  rawRoleName: string | null;
}

export interface DerivedQualifierRow {
  roleName: string;
  qualifier: string;
  tokenizerVersion: string;
  intentFingerprint: string;
}

/**
 * Pure derivation, so the rule is testable without a database.
 *
 * The fingerprint covers the role AND the phrase, so editing the phrase, clearing
 * it, or a tokenizer change all produce a different fingerprint and the row is
 * visibly stale rather than silently reused.
 */
export function deriveCandidateQualifierRows(roles: readonly SelectedRoleIntent[]): DerivedQualifierRow[] {
  const rows: DerivedQualifierRow[] = [];
  const seen = new Set<string>();

  for (const role of roles) {
    const qualifiers = preferredQualifiers(role.rawRoleName, role.roleName);

    if (qualifiers.length === 0) {
      continue;
    }

    const fingerprint = evidenceFingerprint({ title: role.roleName, description: role.rawRoleName });

    for (const qualifier of qualifiers) {
      const key = role.roleName + "\u0000" + qualifier;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      rows.push({ roleName: role.roleName, qualifier, tokenizerVersion: TOKENIZER_VERSION, intentFingerprint: fingerprint });
    }
  }

  return rows;
}

export interface RefreshQualifierTokensResult {
  candidateId: string;
  rolesConsidered: number;
  rowsWritten: number;
  /** The generation just published; older generations are unreachable from here. */
  generation: string;
}

/** The generation a candidate's CURRENT preferences are published under. */
export interface PublishedQualifierGeneration {
  candidateId: string;
  generation: string;
  tokenizerVersion: string;
}

/**
 * Publishes a NEW derivation generation, then advances the pointer.
 *
 * WHY NOT DELETE-THEN-INSERT. The previous implementation deleted the
 * candidate's rows and inserted the replacement as two statements. A failed
 * insert left the candidate with zero rows, which every reader must interpret as
 * "no recorded preference" — a confirmed "Azure preferred" would silently stop
 * ranking. Throwing afterwards does not bring the deleted rows back.
 *
 * STAGED PUBLICATION, in this order, and the order is the whole point:
 *   1. write the new generation's rows (nothing is deleted first);
 *   2. advance the single per-candidate pointer to that generation.
 * A failure before step 2 leaves the PREVIOUS generation current, so the
 * candidate keeps the preferences they had instead of losing them. Step 2 is one
 * statement, so two concurrent refreshes cannot interleave rows from different
 * derivations — the last writer's generation becomes current as a whole.
 *
 * A CONFIRMED EMPTY DERIVATION STILL ADVANCES THE POINTER. That is what keeps "I
 * cleared my preference" distinguishable from "derivation failed" and from
 * "never derived": the pointer exists and the generation has no rows.
 *
 * Old generations are cleaned up best-effort AFTER publication. A cleanup
 * failure is not an error, because the pointer already makes those rows
 * unreachable; reporting failure there would be reporting a problem that no
 * reader can observe.
 */
export async function refreshCandidateQualifierTokens(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<RefreshQualifierTokensResult> {
  const { data, error } = await client
    .from("candidate_selected_roles")
    .select("role_name, raw_role_name")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const roles = ((data ?? []) as Array<{ role_name: string; raw_role_name: string | null }>).map((row) => ({
    roleName: row.role_name,
    rawRoleName: row.raw_role_name,
  }));

  const rows = deriveCandidateQualifierRows(roles);
  const generation = randomUUID();
  const now = new Date().toISOString();

  if (rows.length > 0) {
    const { error: insertError } = await client.from("candidate_qualifier_tokens").insert(
      rows.map((row) => ({
        candidate_id: candidateId,
        role_name: row.roleName,
        qualifier: row.qualifier,
        tokenizer_version: row.tokenizerVersion,
        intent_fingerprint: row.intentFingerprint,
        generation,
        refreshed_at: now,
      })),
    );

    if (insertError) {
      // The pointer has NOT moved, so the previously published generation is
      // still what readers see. Nothing is lost and nothing is half-published.
      throw insertError;
    }
  }

  const { error: pointerError } = await client.from("candidate_qualifier_generations").upsert(
    {
      candidate_id: candidateId,
      generation,
      tokenizer_version: TOKENIZER_VERSION,
      published_at: now,
    },
    { onConflict: "candidate_id" },
  );

  if (pointerError) {
    throw pointerError;
  }

  // Best effort, after publication: only now are older generations unreachable.
  await client
    .from("candidate_qualifier_tokens")
    .delete()
    .eq("candidate_id", candidateId)
    .neq("generation", generation);

  return { candidateId, rolesConsidered: roles.length, rowsWritten: rows.length, generation };
}

/**
 * The candidate's CURRENT published generation, or null when nothing has been
 * published yet.
 *
 * NULL IS UNKNOWN, NOT EMPTY. Callers must not read a missing pointer as "this
 * candidate has no preferences" — it means no derivation has completed, so
 * ranking falls back to priority and the feed says so honestly.
 */
export async function loadPublishedQualifierGeneration(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<PublishedQualifierGeneration | null> {
  const { data, error } = await client
    .from("candidate_qualifier_generations")
    .select("candidate_id, generation, tokenizer_version")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data === null) {
    return null;
  }

  const row = data as { candidate_id: string; generation: string; tokenizer_version: string };

  return { candidateId: row.candidate_id, generation: row.generation, tokenizerVersion: row.tokenizer_version };
}
