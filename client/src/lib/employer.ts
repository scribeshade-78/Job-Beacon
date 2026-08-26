import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * R5.4a client layer. Split the same way R6.1's mailbox.ts is: reads go
 * straight through Supabase (RLS already scopes employer_claims to the
 * caller's own rows via employer_claims_select_own), writes go through
 * server-side Express routes under service_role — a candidate has no
 * INSERT/UPDATE grant on employer_claims at all (see its migration).
 */
export const EMPLOYER_CLAIM_STATUSES = ["pending", "verified", "rejected"] as const;
export type EmployerClaimStatus = (typeof EMPLOYER_CLAIM_STATUSES)[number];

export interface EmployerClaim {
  id: string;
  companyId: string;
  status: EmployerClaimStatus;
  representativeName: string;
  representativeRole: string;
  evidence: string | null;
  domainVerified: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

interface EmployerClaimRow {
  id: string;
  company_id: string;
  status: EmployerClaimStatus;
  representative_name: string;
  representative_role: string;
  evidence: string | null;
  domain_verified: boolean;
  verified_at: string | null;
  created_at: string;
}

const GENERIC_LIST_FAILURE_MESSAGE = "Could not load your employer claims. Please try again.";

export type ListMyEmployerClaimsResult =
  | { kind: "success"; claims: EmployerClaim[] }
  | { kind: "error"; message: string };

export async function listMyEmployerClaims(client: Pick<SupabaseClient, "from">): Promise<ListMyEmployerClaimsResult> {
  try {
    const { data, error } = await client
      .from("employer_claims")
      .select(
        "id, company_id, status, representative_name, representative_role, evidence, domain_verified, verified_at, created_at",
      )
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
    }

    const rows = data as unknown as EmployerClaimRow[];

    return {
      kind: "success",
      claims: rows.map((row) => ({
        id: row.id,
        companyId: row.company_id,
        status: row.status,
        representativeName: row.representative_name,
        representativeRole: row.representative_role,
        evidence: row.evidence,
        domainVerified: row.domain_verified,
        verifiedAt: row.verified_at,
        createdAt: row.created_at,
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
  }
}

const GENERIC_SUBMIT_FAILURE_MESSAGE = "Could not submit your claim. Please try again.";

export type SubmitEmployerClaimResult = { kind: "success" } | { kind: "error"; message: string };

export async function submitEmployerClaim(
  companyId: string,
  representativeName: string,
  representativeRole: string,
  evidence: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitEmployerClaimResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/employer/claims", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        companyId,
        representativeName,
        representativeRole,
        evidence: evidence.trim() === "" ? undefined : evidence,
      }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_SUBMIT_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return { kind: "error", message };
  }

  return { kind: "success" };
}

export interface EmployerClaimQueueEntry {
  id: string;
  userId: string;
  companyId: string;
  companyName: string;
  representativeName: string;
  representativeRole: string;
  evidence: string | null;
  domainVerified: boolean;
  createdAt: string;
}

const GENERIC_QUEUE_FAILURE_MESSAGE = "Could not load the employer claims queue. Please try again.";

export type GetEmployerClaimsQueueResult =
  | { kind: "success"; entries: EmployerClaimQueueEntry[] }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

/** Moderator-facing — server route under service_role, same "server route, not a direct Supabase call" shape as moderation.ts's getModerationQueue (RLS scopes employer_claims to the claimant only). */
export async function getEmployerClaimsQueue(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GetEmployerClaimsQueueResult> {
  let response: Response;

  try {
    response = await fetchImpl("/api/moderation/employer-claims", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_QUEUE_FAILURE_MESSAGE };
  }

  const entries = (await response.json()) as EmployerClaimQueueEntry[];
  return { kind: "success", entries };
}

export const EMPLOYER_CLAIM_DECISIONS = ["verified", "rejected"] as const;
export type EmployerClaimDecisionValue = (typeof EMPLOYER_CLAIM_DECISIONS)[number];

const GENERIC_DECISION_FAILURE_MESSAGE = "Could not record this decision. Please try again.";

export type SubmitEmployerClaimDecisionResult = { kind: "success" } | { kind: "error"; message: string };

export async function submitEmployerClaimDecision(
  claimId: string,
  decision: EmployerClaimDecisionValue,
  rationale: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitEmployerClaimDecisionResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/moderation/employer-claims/${claimId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ decision, rationale }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_DECISION_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return { kind: "error", message };
  }

  return { kind: "success" };
}
