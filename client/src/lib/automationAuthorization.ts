import type { SupabaseClient } from "@supabase/supabase-js";

export type AuthorizationStatus = "authorized" | "paused" | "stopped";

/**
 * Bumped whenever the disclosure text below changes materially, so past
 * consent records stay tied to the wording the candidate actually saw
 * (PRD 9.2: "Consent and audit timestamp").
 */
export const CONSENT_VERSION = "r1-v1";

/**
 * Drawn from PRD 9.2's required-disclosure list, restricted to the items
 * that are actually true of this build today. Role-specific and
 * action-required disclosures are omitted: role selection and the
 * application engine don't exist yet in this repository, and PRD 31
 * explicitly leaves "exact consent copy" as a founder decision — this is
 * the PRD's own stated facts, not invented marketing copy.
 */
export const CONSENT_DISCLOSURE = [
  "No vacancy-by-vacancy approval will be required once discovery and application features are available.",
  "Any exclusions you set apply globally to what JobBeacon considers on your behalf.",
  "You can pause, resume or stop at any time.",
  "This authorization and its timestamp are recorded for your security history.",
] as const;

const GENERIC_FAILURE_MESSAGE = "Could not update your automation status. Please try again.";

export interface Authorization {
  status: AuthorizationStatus;
  consentVersion: string;
  createdAt: string;
  statusChangedAt: string;
}

export type GetAuthorizationResult =
  | { kind: "authorized"; authorization: Authorization }
  | { kind: "notYetAuthorized" }
  | { kind: "error"; message: string };

type AuthorizationClient = Pick<SupabaseClient, "from">;

export async function getAuthorization(
  client: AuthorizationClient,
): Promise<GetAuthorizationResult> {
  try {
    const { data, error } = await client
      .from("automation_authorizations")
      .select("status, consent_version, created_at, status_changed_at")
      .maybeSingle();

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    if (!data) {
      return { kind: "notYetAuthorized" };
    }

    return {
      kind: "authorized",
      authorization: {
        status: data.status,
        consentVersion: data.consent_version,
        createdAt: data.created_at,
        statusChangedAt: data.status_changed_at,
      },
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export type SetAuthorizationResult = { kind: "success" } | { kind: "error"; message: string };

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * First-time consent. A 23505 unique-violation (row already exists, e.g.
 * a double-click or a race between tabs) is treated as success — same
 * idempotent-on-duplicate pattern as ensureCandidateProfile and
 * setExclusion — not a failure.
 */
export async function authorize(
  client: AuthorizationClient,
  candidateId: string,
): Promise<SetAuthorizationResult> {
  try {
    const { error } = await client.from("automation_authorizations").insert({
      candidate_id: candidateId,
      status: "authorized",
      consent_version: CONSENT_VERSION,
    });

    if (error && error.code !== POSTGRES_UNIQUE_VIOLATION) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

async function setStatus(
  client: AuthorizationClient,
  candidateId: string,
  status: AuthorizationStatus,
): Promise<SetAuthorizationResult> {
  try {
    // PostgREST rejects UPDATE with no WHERE clause outright (error 21000)
    // as its own safety net against accidental full-table updates — this
    // filter is required even though RLS's WITH CHECK would separately
    // have scoped the update to the caller's own row regardless.
    const { error } = await client
      .from("automation_authorizations")
      .update({ status, status_changed_at: new Date().toISOString() })
      .eq("candidate_id", candidateId);

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export const pause = (client: AuthorizationClient, candidateId: string) =>
  setStatus(client, candidateId, "paused");
export const resume = (client: AuthorizationClient, candidateId: string) =>
  setStatus(client, candidateId, "authorized");
export const stop = (client: AuthorizationClient, candidateId: string) =>
  setStatus(client, candidateId, "stopped");
