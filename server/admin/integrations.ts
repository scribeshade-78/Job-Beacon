import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration readiness for the admin console.
 *
 * WHAT THIS EXISTS TO ANSWER. "Is Adzuna wired up?" had no answer that did not involve
 * reading server environment variables or opening a SQL client. This reports, per
 * integration, whether the SERVER can use it — and nothing else.
 *
 * IT NEVER RETURNS A VALUE. Only booleans and variable NAMES. An admin console is a
 * browser surface, and a key that reaches it has left the server for good; an operator
 * does not need to see a key to know it is present, and needs the NAME of a missing one
 * to fix it. The unit test asserts this by planting a sentinel and searching the
 * serialized response for it.
 */

export interface IntegrationDefinition {
  id: string;
  label: string;
  /** What this integration is for, in the operator's terms. */
  purpose: string;
  /** Variable NAMES only — never values. */
  requiredEnv: readonly string[];
  /** The source_code whose governance row and targets are reported, when it is a source. */
  sourceCode?: string;
  /**
   * True for a credentialed source that must stay on the candidate-pressed path only
   * until its terms review clears. Surfaced so the console can say so rather than
   * leaving an operator to infer it.
   */
  requiresReview?: boolean;
}

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: "adzuna",
    label: "Adzuna",
    purpose: "The licensed job aggregator. Candidate-pressed intake only.",
    requiredEnv: ["ADZUNA_APP_ID", "ADZUNA_APP_KEY"],
    sourceCode: "adzuna",
    requiresReview: true,
  },
];

export interface IntegrationStatus {
  id: string;
  label: string;
  purpose: string;
  /** True when every required variable is present and non-blank. */
  configured: boolean;
  /** The names that are missing. Never values. */
  missingEnv: string[];
  sourceCode: string | null;
  discoveryAllowed: boolean | null;
  killSwitch: boolean | null;
  policyVersion: string | null;
  /** Enabled vacancy_sources rows — 0 means configured but not scheduled. */
  enabledTargets: number | null;
  requiresReview: boolean;
}

export interface IntegrationsOverview {
  integrations: IntegrationStatus[];
}

/**
 * Presence only. A variable set to an empty or whitespace string is MISSING, not
 * configured: that is the classic half-finished deployment, where the app looks wired up
 * and fails at the first request.
 */
export function readEnvPresence(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { configured: boolean; missingEnv: string[] } {
  const missingEnv = names.filter((name) => {
    const value = env[name];
    return typeof value !== "string" || value.trim() === "";
  });

  return { configured: missingEnv.length === 0, missingEnv };
}

export async function listIntegrations(
  client: Pick<SupabaseClient, "from">,
  env: Record<string, string | undefined> = process.env,
): Promise<IntegrationsOverview> {
  const integrations = await Promise.all(
    INTEGRATIONS.map(async (definition): Promise<IntegrationStatus> => {
      const { configured, missingEnv } = readEnvPresence(definition.requiredEnv, env);

      const base: IntegrationStatus = {
        id: definition.id,
        label: definition.label,
        purpose: definition.purpose,
        configured,
        missingEnv,
        sourceCode: definition.sourceCode ?? null,
        discoveryAllowed: null,
        killSwitch: null,
        policyVersion: null,
        enabledTargets: null,
        requiresReview: definition.requiresReview === true,
      };

      if (!definition.sourceCode) {
        return base;
      }

      // A read failure THROWS. Reporting "not configured" for a database error would
      // tell an operator to check environment variables that were never the problem.
      const { data: policy, error: policyError } = await client
        .from("source_policies")
        .select("discovery_allowed, kill_switch, policy_version")
        .eq("source_code", definition.sourceCode)
        .maybeSingle();

      if (policyError) {
        throw policyError;
      }

      const { count, error: countError } = await client
        .from("vacancy_sources")
        .select("id", { count: "exact", head: true })
        .eq("source_code", definition.sourceCode)
        .eq("enabled", true);

      if (countError) {
        throw countError;
      }

      const row = policy as
        | { discovery_allowed: boolean; kill_switch: boolean; policy_version: string | null }
        | null;

      return {
        ...base,
        discoveryAllowed: row?.discovery_allowed ?? null,
        killSwitch: row?.kill_switch ?? null,
        policyVersion: row?.policy_version ?? null,
        enabledTargets: count ?? 0,
      };
    }),
  );

  return { integrations };
}
