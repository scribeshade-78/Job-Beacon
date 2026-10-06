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
  generation: string;
  /**
   * "published" when this generation became current. "stale" when the
   * candidate's intent moved while this refresh was working, so a NEWER refresh
   * owns publication and this one deliberately did not overwrite it. Stale is
   * not an error: it is the race being lost safely.
   */
  outcome: "published" | "stale";
}

/**
 * Fingerprint of a candidate's whole confirmed intent set.
 *
 * Sorted, so the same selections in a different order are the same intent, and
 * it changes when a role is added, removed, edited or cleared — which is exactly
 * what makes the publication compare-and-swap meaningful.
 */
export function intentFingerprintOf(roles: readonly SelectedRoleIntent[]): string {
  const canonical = [...roles]
    .map((role) => role.roleName + "\u0001" + (role.rawRoleName ?? ""))
    .sort()
    .join("\u0002");

  return evidenceFingerprint({ title: canonical, description: null });
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
  const derivedFingerprint = intentFingerprintOf(roles);

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

  // RE-READ INTENT AT PUBLICATION TIME. This refresh may have been in flight
  // while the candidate edited or cleared their preference. Publishing a
  // derivation of the OLD intent would silently revert that edit while looking
  // successful, so the derivation is compared against intent as it is NOW.
  const { data: freshData, error: freshError } = await client
    .from("candidate_selected_roles")
    .select("role_name, raw_role_name")
    .eq("candidate_id", candidateId);

  if (freshError) {
    throw freshError;
  }

  const freshRoles = ((freshData ?? []) as Array<{ role_name: string; raw_role_name: string | null }>).map((row) => ({
    roleName: row.role_name,
    rawRoleName: row.raw_role_name,
  }));

  if (intentFingerprintOf(freshRoles) !== derivedFingerprint) {
    // The candidate's intent moved. A newer refresh owns publication; this one
    // must not overwrite it, and losing this race is not an error.
    return { candidateId, rolesConsidered: roles.length, rowsWritten: 0, generation, outcome: "stale" };
  }

  const { data: pointerData, error: pointerReadError } = await client
    .from("candidate_qualifier_generations")
    .select("candidate_id, intent_fingerprint")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (pointerReadError) {
    throw pointerReadError;
  }

  const pointer = pointerData as { candidate_id: string; intent_fingerprint: string | null } | null;

  if (pointer === null) {
    const { error: insertPointerError } = await client.from("candidate_qualifier_generations").insert({
      candidate_id: candidateId,
      generation,
      tokenizer_version: TOKENIZER_VERSION,
      intent_fingerprint: derivedFingerprint,
      published_at: now,
    });

    if (insertPointerError) {
      // Another refresh published first (primary-key conflict) or the write
      // failed. Either way this generation is not current and must not be
      // presented as such.
      return { candidateId, rolesConsidered: roles.length, rowsWritten: 0, generation, outcome: "stale" };
    }
  } else {
    // COMPARE-AND-SWAP on the intent the current pointer was derived from. A
    // pointer with a NULL fingerprint predates the guard, so it is unverifiable:
    // one re-derivation is allowed to replace it, which is the conservative
    // reading rather than treating an unverifiable generation as current.
    const unverifiable = pointer.intent_fingerprint === null;

    const swap = client.from("candidate_qualifier_generations").update({
      generation,
      tokenizer_version: TOKENIZER_VERSION,
      intent_fingerprint: derivedFingerprint,
      published_at: now,
    });

    const filtered = unverifiable
      ? swap.eq("candidate_id", candidateId)
      : swap.eq("candidate_id", candidateId).eq("intent_fingerprint", pointer.intent_fingerprint);

    const { data: swapped, error: swapError } = await filtered.select("candidate_id");

    if (swapError) {
      throw swapError;
    }

    if (!Array.isArray(swapped) || swapped.length !== 1) {
      // The pointer moved while this refresh was working. That is the race being
      // LOST SAFELY: a newer generation is current and stays current.
      return { candidateId, rolesConsidered: roles.length, rowsWritten: 0, generation, outcome: "stale" };
    }
  }

  // Best effort, after publication: only now are older generations unreachable.
  await client
    .from("candidate_qualifier_tokens")
    .delete()
    .eq("candidate_id", candidateId)
    .neq("generation", generation);

  return { candidateId, rolesConsidered: roles.length, rowsWritten: rows.length, generation, outcome: "published" };
}

/**
 * The candidate's CURRENT, VALID published generation, or null when there is
 * none that may be trusted.
 *
 * NULL IS UNKNOWN, NOT EMPTY. Callers must not read a missing pointer as "this
 * candidate has no preferences": it means no trustworthy derivation exists, so
 * ranking falls back to priority and the feed must say so honestly.
 *
 * READ-TIME VALIDITY, NOT POINTER TRUST. This is the part the publication guard
 * could not cover. Publication deliberately keeps the PREVIOUS generation
 * current when a refresh loses the race or is abandoned — which is right for a
 * failed refresh and WRONG once the candidate has edited or cleared their
 * intent, because that older generation's rows no longer correspond to anything
 * they recorded. The pointer's stored fingerprint therefore proves only what the
 * generation was derived FROM; it is not the source of truth for what the
 * candidate's intent IS now.
 *
 * So the current intent is recomputed here and compared. A mismatch means the
 * published generation is STALE, and a stale generation is returned as UNKNOWN
 * rather than as preferences: presenting "Azure" as a current preference after
 * the candidate cleared it is exactly the silent staleness this guards.
 *
 * RESIDUAL WINDOW, STATED PLAINLY: intent can still change between this read and
 * the caller's use of it. That window is unavoidable without reading intent and
 * preferences in one transaction; it is bounded, self-healing on the next read,
 * and never turns a cleared preference into a permanent boost. A pre-guard
 * pointer with a NULL fingerprint is likewise treated as unverifiable.
 */
export async function loadPublishedQualifierGeneration(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<PublishedQualifierGeneration | null> {
  const { data, error } = await client
    .from("candidate_qualifier_generations")
    .select("candidate_id, generation, tokenizer_version, intent_fingerprint")
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data === null) {
    return null;
  }

  const row = data as {
    candidate_id: string;
    generation: string;
    tokenizer_version: string;
    intent_fingerprint: string | null;
  };

  if (row.intent_fingerprint === null) {
    // Published before the guard existed: unverifiable, so not trustworthy.
    return null;
  }

  const { data: roleData, error: roleError } = await client
    .from("candidate_selected_roles")
    .select("role_name, raw_role_name")
    .eq("candidate_id", candidateId);

  if (roleError) {
    throw roleError;
  }

  const roles = ((roleData ?? []) as Array<{ role_name: string; raw_role_name: string | null }>).map((entry) => ({
    roleName: entry.role_name,
    rawRoleName: entry.raw_role_name,
  }));

  if (intentFingerprintOf(roles) !== row.intent_fingerprint) {
    // The candidate's intent has moved since this generation was published. The
    // generation is stale and must not be presented as current preferences.
    return null;
  }

  return { candidateId: row.candidate_id, generation: row.generation, tokenizerVersion: row.tokenizer_version };
}
