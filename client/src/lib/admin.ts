/**
 * R8.1 Admin Operations Panel client — same "server-side Express route, not
 * a direct Supabase call" shape as lib/moderation.ts: source_policies /
 * vacancy_trust_scores / candidate_profiles are all read through
 * requireAuth + requireAdmin-protected routes (no request-scoped RLS
 * client exists in this project).
 */

export interface AdminOverview {
  openModerationCases: number;
  activeSources: number;
  totalCandidates: number;
}

export interface SourcePolicy {
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

/** Keep in sync with server/admin/sources.ts EDITABLE_SOURCE_POLICY_FIELDS. */
export const EDITABLE_SOURCE_POLICY_FIELDS = [
  "discovery_allowed",
  "storage_allowed",
  "display_allowed",
  "automated_application_allowed",
  "kill_switch",
] as const;

export type EditableSourcePolicyField = (typeof EDITABLE_SOURCE_POLICY_FIELDS)[number];

export interface TrustScoreEntry {
  id: string;
  vacancyId: string;
  vacancyTitle: string;
  status: string;
  score: number | null;
  policyVersion: string;
  scoredAt: string;
}

export type TrustWeights = Record<string, number>;

export type AdminFetchResult<T> =
  | { kind: "success"; data: T }
  | { kind: "forbidden" }
  | { kind: "error"; message: string };

const GENERIC_FAILURE = "Something went wrong. Please try again.";

async function adminGet<T>(path: string, accessToken: string, fetchImpl: typeof fetch): Promise<AdminFetchResult<T>> {
  let response: Response;

  try {
    response = await fetchImpl(path, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  return { kind: "success", data: (await response.json()) as T };
}

export function getAdminOverview(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return adminGet<AdminOverview>("/api/admin/overview", accessToken, fetchImpl);
}

export function getAdminSources(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return adminGet<SourcePolicy[]>("/api/admin/sources", accessToken, fetchImpl);
}

export function getAdminTrustScores(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return adminGet<TrustScoreEntry[]>("/api/admin/trust-scores", accessToken, fetchImpl);
}

export function getAdminTrustWeights(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return adminGet<TrustWeights>("/api/admin/trust-weights", accessToken, fetchImpl);
}

export async function updateAdminSource(
  sourceCode: string,
  patch: Partial<Record<EditableSourcePolicyField, boolean>>,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdminFetchResult<SourcePolicy>> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/admin/sources/${encodeURIComponent(sourceCode)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(patch),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "forbidden" };
  }

  if (!response.ok) {
    let message = GENERIC_FAILURE;
    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // keep the generic message
    }
    return { kind: "error", message };
  }

  return { kind: "success", data: (await response.json()) as SourcePolicy };
}
