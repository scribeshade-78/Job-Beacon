import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The candidate's selected target roles, including WHAT THEY ACTUALLY ASKED FOR.
 *
 * role_name keeps its established meaning — it is what every matcher reads — and
 * raw_role_name/normalized_role_id are additive metadata recorded alongside it
 * (20261001200000_candidate_selected_roles_raw_intent.sql).
 *
 * NULL MEANS NOT RECORDED, NEVER "same as role_name". Legacy rows have no raw
 * intent, and reconstructing one from role_name would invent a request the
 * candidate never made. The UI must present null as unknown.
 *
 * OFFICIAL SCHEMA ORDERING: this module selects and writes the two new columns,
 * so it requires the migration. There is deliberately NO fallback query that
 * drops them on 42703: silently discarding the metadata would look exactly like
 * "the candidate never recorded a phrase", which is the one reading that must
 * not be faked. Against an un-migrated database the load fails loudly.
 */

export interface SelectedRole {
  id: string;
  roleName: string;
  /** The candidate's own phrase, or null when not recorded (legacy rows). */
  rawRoleName: string | null;
  /** Stable shared/roleTaxonomy.ts id, or null for a custom role / legacy row. */
  normalizedRoleId: string | null;
  createdAt: string;
}

const GENERIC_LIST_FAILURE_MESSAGE = "Could not load your target roles. Please try again.";
const GENERIC_MUTATE_FAILURE_MESSAGE = "Could not update your target roles. Please try again.";
const POSTGRES_UNIQUE_VIOLATION = "23505";

export type ListSelectedRolesResult =
  | { kind: "success"; roles: SelectedRole[] }
  | { kind: "error"; message: string };

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * candidate_selected_roles RLS scopes SELECT to the signed-in candidate's own
 * rows — direct browser->Supabase read, same shape as listExclusions.
 */
export async function listSelectedRoles(client: Pick<SupabaseClient, "from">): Promise<ListSelectedRolesResult> {
  try {
    const { data, error } = await client
      .from("candidate_selected_roles")
      .select("id, role_name, raw_role_name, normalized_role_id, created_at")
      .order("created_at", { ascending: true });

    if (error || !data) {
      return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      roles: data.map((row) => ({
        id: row.id,
        roleName: row.role_name,
        rawRoleName: stringOrNull(row.raw_role_name),
        normalizedRoleId: stringOrNull(row.normalized_role_id),
        createdAt: row.created_at,
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
  }
}

export type SelectRoleResult = { kind: "success" } | { kind: "error"; message: string };

export interface SelectRoleOptions {
  /**
   * The candidate's own phrase. Written ONLY from an explicit selection or
   * confirmation — never copied from a search box on the candidate's behalf,
   * because a query that returned several roles is not each role's intent.
   */
  rawRoleName?: string | null;
  /** The catalog id the selection came from, when it came from the catalog. */
  normalizedRoleId?: string | null;
}

/**
 * Selecting a role already selected (unique (candidate_id, role_name)) is
 * treated as success, same idempotent-on-duplicate pattern as setExclusion.
 *
 * IT DELIBERATELY DOES NOT UPDATE ON CONFLICT. The uniqueness key is
 * (candidate_id, role_name), so one row holds ONE raw phrase per canonical role;
 * allowing that phrase to be part of the key would let the same role be selected
 * twice with different intents, which the schema cannot express. Given the
 * conflict, the previously recorded intent is the candidate's actual earlier
 * request and must not be silently overwritten by a later generic query.
 */
export async function selectRole(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  roleName: string,
  options: SelectRoleOptions = {},
): Promise<SelectRoleResult> {
  try {
    const { error } = await client.from("candidate_selected_roles").insert({
      candidate_id: candidateId,
      role_name: roleName,
      raw_role_name: stringOrNull(options.rawRoleName),
      normalized_role_id: stringOrNull(options.normalizedRoleId),
    });

    if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
      return { kind: "error", message: GENERIC_MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_MUTATE_FAILURE_MESSAGE };
  }
}

export type ReplaceRoleIntentResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * DELIBERATE replacement of a recorded intent, by row id.
 *
 * WHY THIS EXISTS SEPARATELY FROM selectRole. selectRole deliberately refuses to
 * touch an existing row on a 23505 conflict, because the earlier phrase is the
 * candidate's actual request and a later generic query must not silently replace
 * it. That refusal leaves a real need: a candidate who genuinely wants to change
 * what they recorded. This is the explicit, opt-in path for that — it never runs
 * as a side effect of a normal selection.
 *
 * SCOPED BY RLS. The update is by primary key, and
 * candidate_selected_roles_update_own scopes it to the caller's own rows, so one
 * candidate cannot rewrite another's intent and no extra policy or grant is
 * required. role_name is NOT changed: this replaces the recorded phrase, not the
 * occupation the candidate selected.
 */
export async function replaceRoleIntent(
  client: Pick<SupabaseClient, "from">,
  id: string,
  options: SelectRoleOptions = {},
): Promise<ReplaceRoleIntentResult> {
  try {
    const { error } = await client
      .from("candidate_selected_roles")
      .update({
        raw_role_name: stringOrNull(options.rawRoleName),
        normalized_role_id: stringOrNull(options.normalizedRoleId),
      })
      .eq("id", id);

    if (error) {
      return { kind: "error", message: GENERIC_MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_MUTATE_FAILURE_MESSAGE };
  }
}

export type RemoveRoleResult = { kind: "success" } | { kind: "error"; message: string };

/** Delete by row id — candidate_selected_roles_delete_own RLS still scopes this to the caller's own rows. */
export async function removeRole(client: Pick<SupabaseClient, "from">, id: string): Promise<RemoveRoleResult> {
  try {
    const { error } = await client.from("candidate_selected_roles").delete().eq("id", id);

    if (error) {
      return { kind: "error", message: GENERIC_MUTATE_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_MUTATE_FAILURE_MESSAGE };
  }
}
