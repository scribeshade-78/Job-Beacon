/**
 * SQL-COMPARABLE derivation inputs for the ranked feed (D1-RANK).
 *
 * WHY THESE EXIST. The freshness fingerprints (roleInputFingerprint,
 * intentFingerprintOf, evidenceFingerprint) are FNV hashes computed in
 * TypeScript; SQL cannot recompute them, so it cannot prove that a recorded
 * generation still matches the candidate's CURRENT rows. These helpers build the
 * canonical, JSONB-comparable shape the writers persist beside the fingerprints,
 * and the SQL builders in
 * supabase/migrations/20261001340000_candidate_ranked_opportunities.sql produce
 * the SAME shape from the same rows.
 *
 * ORDERING, DUPLICATES, NULL. Ordering is by code unit (JSON.stringify of these
 * arrays is the stored value; SQL aggregates with COLLATE "C", which tracks the
 * JS code-unit order for the ASCII values this product stores). Duplicates are
 * PRESERVED exactly as the writers see them — candidate_selected_roles has a
 * unique (candidate_id, role_name) key, so there are none in practice, and
 * dropping them here would silently disagree with SQL if that ever changed. A
 * NULL raw_role_name normalises to the empty string, exactly as
 * intentFingerprintOf() (shared/../server/applications/candidateQualifierTokens.ts)
 * treats it.
 *
 * THIS MODULE DOES NOT MATCH. It never decides role relevance or qualifier
 * membership; it only canonicalises inputs for equality comparison.
 */

export interface SelectedRoleInputRow {
  roleName: string;
  /**
   * The candidate's own confirmed phrase. Absent or NULL means NOT RECORDED and
   * is normalised to "" for the intent canonical; role matching does not use it,
   * so a role-only input is valid here.
   */
  rawRoleName?: string | null;
}

export interface RoleInputCanonicalEntry {
  role_name: string;
}

export interface IntentCanonicalEntry {
  role_name: string;
  raw_role_name: string;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The selected-role inputs used by role matching, sorted by role_name.
 * This is what candidate_role_match_coverage.role_input_canonical records.
 */
export function roleInputsCanonical(rows: readonly SelectedRoleInputRow[]): RoleInputCanonicalEntry[] {
  return rows
    .map((row) => ({ role_name: row.roleName }))
    .sort((a, b) => compareCodeUnits(a.role_name, b.role_name));
}

/**
 * The confirmed intent inputs used by qualifier derivation, sorted by
 * (role_name, raw_role_name). This is what
 * candidate_qualifier_generations.intent_canonical records.
 */
export function intentCanonical(rows: readonly SelectedRoleInputRow[]): IntentCanonicalEntry[] {
  return rows
    .map((row) => ({ role_name: row.roleName, raw_role_name: row.rawRoleName ?? "" }))
    .sort(
      (a, b) =>
        compareCodeUnits(a.role_name, b.role_name) || compareCodeUnits(a.raw_role_name, b.raw_role_name),
    );
}
