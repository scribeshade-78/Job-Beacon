/**
 * Task H4 — audit trail, security events and employer ATS credentials.
 *
 * Same "server-side Express route, not a direct Supabase call" shape as
 * lib/admin.ts and lib/billing.ts: audit_events, security_events and
 * ats_credentials are all reached through requireAuth + requireAdmin-protected
 * routes, and neither POST here is a write the client is trusted to decide —
 * the routes validate the input and the database trigger re-derives the source
 * policy on their behalf.
 *
 * THE SECRET DIRECTION OF THIS MODULE. Read functions return hints. There is no
 * "include the key" parameter anywhere below, because the route that would need
 * one deliberately has no code path that selects secret_ciphertext. An admin
 * screen can therefore show which key is installed without a decrypt path
 * existing for display purposes — which is the whole point.
 */

import type { AdminFetchResult } from "./admin";

/** Mirrors server/audit/log.ts AuditEventRecord. */
export interface AuditEventRecord {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  reason: string | null;
  previousValues: unknown;
  newValues: unknown;
}

export type SecuritySeverity = "low" | "medium" | "high";

/** Mirrors server/security/events.ts SecurityEventRecord. */
export interface SecurityEventRecord {
  id: string;
  occurredAt: string;
  eventType: string;
  severity: SecuritySeverity;
  source: string;
  subjectId: string | null;
  detail: Record<string, unknown> | null;
}

export type AtsSourceCode = "greenhouse" | "lever";

/** Keep in sync with server/ats/credentials.ts ATS_SOURCE_CODES. */
export const ATS_SOURCE_CODES: readonly AtsSourceCode[] = ["greenhouse", "lever"];

/**
 * Mirrors server/ats/credentials.ts AtsCredentialSummary.
 *
 * keyHint is the last four characters of the key. It is the ONLY part of the key
 * any response carries, and it is meant to be displayed: it identifies which key
 * is installed, which is what a rotation is judged against.
 */
export interface AtsCredentialSummary {
  id: string;
  sourceCode: AtsSourceCode;
  employerKey: string;
  label: string | null;
  companyId: string | null;
  keyHint: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Reuses admin.ts's union rather than redeclaring it — same three states, same meanings. */
export type AuditFetchResult<T> = AdminFetchResult<T>;

export interface StoreAtsCredentialInput {
  sourceCode: AtsSourceCode;
  employerKey: string;
  /** The full plaintext key, in transit once. Encrypted on arrival; never returned. */
  secret: string;
  label?: string;
}

/** What POST /api/admin/ats-credentials answers with: the metadata echoed back, plus the hint. Not the key. */
export interface StoredAtsCredential {
  id: string;
  sourceCode: AtsSourceCode;
  employerKey: string;
  keyHint: string;
}

export interface AtsCredentialActiveResult {
  id: string;
  isActive: boolean;
  /** The server's statement of the consequence: which way automated application just moved. */
  note: string;
}

const GENERIC_FAILURE = "Something went wrong. Please try again.";

async function request<T>(
  path: string,
  accessToken: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<AuditFetchResult<T>> {
  let response: Response;

  try {
    response = await fetchImpl(path, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: "Bearer " + accessToken },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    // These routes carry reasons worth reading verbatim: which required field
    // was missing, or — on the 503 — the name of the unset environment
    // variable. `reason` is server prose about the deployment (an env var name,
    // a length rule) and never a key value, so it is safe to show.
    let message = GENERIC_FAILURE;
    try {
      const body = (await response.json()) as { error?: unknown; reason?: unknown };
      if (typeof body?.error === "string" && body.error.length > 0) {
        message = body.error;
      }
      if (typeof body?.reason === "string" && body.reason.length > 0) {
        message = message === GENERIC_FAILURE ? body.reason : message + " " + body.reason;
      }
    } catch {
      // keep the generic message
    }
    return { kind: "error", message };
  }

  return { kind: "success", data: (await response.json()) as T };
}

export function listAuditEvents(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<{ events: AuditEventRecord[] }>(
    "/api/admin/audit-events",
    accessToken,
    { method: "GET" },
    fetchImpl,
  );
}

export function listSecurityEvents(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<{ events: SecurityEventRecord[] }>(
    "/api/admin/security-events",
    accessToken,
    { method: "GET" },
    fetchImpl,
  );
}

export function listAtsCredentials(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return request<{ credentials: AtsCredentialSummary[] }>(
    "/api/admin/ats-credentials",
    accessToken,
    { method: "GET" },
    fetchImpl,
  );
}

/**
 * Installs or rotates the credential for one (source, employer). The secret
 * appears in exactly one client request body and in no response, so the caller
 * only ever learns the hint back.
 */
export function storeAtsCredential(
  input: StoreAtsCredentialInput,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return request<StoredAtsCredential>(
    "/api/admin/ats-credentials",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
}

export function setAtsCredentialActive(
  id: string,
  isActive: boolean,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return request<AtsCredentialActiveResult>(
    "/api/admin/ats-credentials/" + encodeURIComponent(id) + "/active",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    },
    fetchImpl,
  );
}
