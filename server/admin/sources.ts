import type { SupabaseClient } from "@supabase/supabase-js";

export interface SourcePolicyRow {
  source_code: string;
  discovery_allowed: boolean;
  storage_allowed: boolean;
  display_allowed: boolean;
  automated_application_allowed: boolean;
  authentication_method: string;
  rate_limit: string | null;
  countries: string[];
  policy_version: string;
  last_legal_review_at: string | null;
  kill_switch: boolean;
  created_at: string;
  updated_at: string;
}

export async function listSourcePolicies(client: SupabaseClient): Promise<SourcePolicyRow[]> {
  const { data, error } = await client.from("source_policies").select("*").order("source_code");

  if (error) {
    throw error;
  }

  return (data ?? []) as SourcePolicyRow[];
}

/**
 * Only these operational toggles are admin-editable from R8.1 —
 * policy_version, authentication_method, countries, and
 * last_legal_review_at are governance fields set by the legal/policy
 * review process this UI doesn't own.
 */
export const EDITABLE_SOURCE_POLICY_FIELDS = [
  "discovery_allowed",
  "storage_allowed",
  "display_allowed",
  "automated_application_allowed",
  "kill_switch",
] as const;

export type EditableSourcePolicyField = (typeof EDITABLE_SOURCE_POLICY_FIELDS)[number];

export class SourcePolicyNotFoundError extends Error {
  constructor(sourceCode: string) {
    super(`Source policy not found: ${sourceCode}`);
    this.name = "SourcePolicyNotFoundError";
  }
}

export async function updateSourcePolicy(
  client: SupabaseClient,
  sourceCode: string,
  patch: Partial<Record<EditableSourcePolicyField, boolean>>,
): Promise<SourcePolicyRow> {
  const { data, error } = await client
    .from("source_policies")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("source_code", sourceCode)
    .select("*")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new SourcePolicyNotFoundError(sourceCode);
  }

  return data as SourcePolicyRow;
}
