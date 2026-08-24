import type { SupabaseClient } from "@supabase/supabase-js";

export interface SelectedRole {
  id: string;
  roleName: string;
  createdAt: string;
}

const GENERIC_LIST_FAILURE_MESSAGE = "Could not load your target roles. Please try again.";
const GENERIC_MUTATE_FAILURE_MESSAGE = "Could not update your target roles. Please try again.";
const POSTGRES_UNIQUE_VIOLATION = "23505";

export type ListSelectedRolesResult =
  | { kind: "success"; roles: SelectedRole[] }
  | { kind: "error"; message: string };

/**
 * candidate_selected_roles RLS scopes SELECT to the signed-in candidate's
 * own rows — direct browser->Supabase read, same shape as listExclusions.
 */
export async function listSelectedRoles(client: Pick<SupabaseClient, "from">): Promise<ListSelectedRolesResult> {
  try {
    const { data, error } = await client
      .from("candidate_selected_roles")
      .select("id, role_name, created_at")
      .order("created_at", { ascending: true });

    if (error || !data) {
      return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      roles: data.map((row) => ({ id: row.id, roleName: row.role_name, createdAt: row.created_at })),
    };
  } catch {
    return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
  }
}

export type SelectRoleResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * Selecting a role already selected (unique (candidate_id, role_name)) is
 * treated as success, same idempotent-on-duplicate pattern as setExclusion.
 */
export async function selectRole(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  roleName: string,
): Promise<SelectRoleResult> {
  try {
    const { error } = await client
      .from("candidate_selected_roles")
      .insert({ candidate_id: candidateId, role_name: roleName });

    if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
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
