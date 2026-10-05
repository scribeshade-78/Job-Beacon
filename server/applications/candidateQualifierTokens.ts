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
}

/**
 * Replaces the candidate's derived qualifier rows.
 *
 * A REPLACE, NOT AN APPEND: a cleared phrase, an edited phrase or a removed role
 * must REMOVE the old rows, which is why the delete runs first. Both statements
 * are scoped by candidate_id because service_role bypasses RLS, and any error
 * throws — a partial refresh reported as success would silently rank on stale
 * intent.
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

  const { error: deleteError } = await client
    .from("candidate_qualifier_tokens")
    .delete()
    .eq("candidate_id", candidateId);

  if (deleteError) {
    throw deleteError;
  }

  if (rows.length === 0) {
    return { candidateId, rolesConsidered: roles.length, rowsWritten: 0 };
  }

  const { error: insertError } = await client.from("candidate_qualifier_tokens").insert(
    rows.map((row) => ({
      candidate_id: candidateId,
      role_name: row.roleName,
      qualifier: row.qualifier,
      tokenizer_version: row.tokenizerVersion,
      intent_fingerprint: row.intentFingerprint,
      refreshed_at: new Date().toISOString(),
    })),
  );

  if (insertError) {
    throw insertError;
  }

  return { candidateId, rolesConsidered: roles.length, rowsWritten: rows.length };
}
