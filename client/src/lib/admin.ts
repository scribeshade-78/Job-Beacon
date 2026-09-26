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

/** The two roles this console can grant. Mirrors server/admin/roles.ts MANAGEABLE_ROLES. */
export type ManageableRole = "admin" | "moderator";

export const MANAGEABLE_ROLES: readonly ManageableRole[] = ["admin", "moderator"];

export interface AdminRoleAssignment {
  userId: string;
  role: ManageableRole;
  createdAt: string;
  /** Null when the account has no email, or when it fell outside the server page bound. */
  email: string | null;
  /** True for the signed-in admin own row — a UX signal only; the server refuses self-revocation regardless. */
  isSelf: boolean;
}

export interface AdminRoleList {
  assignments: AdminRoleAssignment[];
  truncated: boolean;
}

export interface GrantAdminRoleResult {
  userId: string;
  /** The registered address, which may differ in casing from what was submitted. */
  email: string;
  role: ManageableRole;
  /** The row already existed, so nothing was written and no audit event was recorded. */
  alreadyHeld: boolean;
}

export interface RevokeAdminRoleResult {
  userId: string;
  role: ManageableRole;
  removed: boolean;
}

/**
 * R8.2 role management. These three routes are the only write path to
 * public.user_roles, which is service_role-only at the database grant level —
 * so nothing here could grant a role by talking to Supabase directly even if
 * it tried. The server decides, validates, and audits.
 */
async function adminSend<T>(
  path: string,
  accessToken: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<AdminFetchResult<T>> {
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
    // These routes carry reasons worth reading verbatim: which field was
    // missing, that no account has the address, or the self-lockout refusal.
    let message = GENERIC_FAILURE;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // keep the generic message
    }
    return { kind: "error", message };
  }

  return { kind: "success", data: (await response.json()) as T };
}

export function getAdminRoles(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return adminGet<AdminRoleList>("/api/admin/roles", accessToken, fetchImpl);
}

export function grantAdminRole(
  email: string,
  role: ManageableRole,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return adminSend<GrantAdminRoleResult>(
    "/api/admin/roles",
    accessToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    },
    fetchImpl,
  );
}

export function revokeAdminRole(
  userId: string,
  role: ManageableRole,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  // Path segments, not a DELETE body: a proxy is free to strip the latter.
  const path = "/api/admin/roles/" + encodeURIComponent(userId) + "/" + encodeURIComponent(role);
  return adminSend<RevokeAdminRoleResult>(path, accessToken, { method: "DELETE" }, fetchImpl);
}

/**
 * Source health — GET /api/admin/source-health.
 *
 * Read-only mirror of public.source_health_events, the per-run fetch log the
 * intake path and the scheduled worker both write. The route enforces the
 * window; this module only names it.
 */
export type SourceHealthStatus = "success" | "error";

/** Keep in sync with server/admin/sourceHealth.ts SOURCE_HEALTH_STATUSES. */
export const SOURCE_HEALTH_STATUSES: readonly SourceHealthStatus[] = ["success", "error"];

export interface SourceHealthEvent {
  id: string;
  sourceCode: string;
  vacancySourceId: string | null;
  status: SourceHealthStatus;
  vacanciesFetched: number;
  /** Where the useful failure detail lives, including any HTTP status inside it. */
  errorMessage: string | null;
  durationMs: number | null;
  runAt: string;
}

/** One source's rollup over the loaded window only — not lifetime totals. */
export interface SourceHealthSummary {
  sourceCode: string;
  latestRunAt: string;
  latestStatus: SourceHealthStatus;
  latestErrorMessage: string | null;
  latestVacanciesFetched: number;
  latestDurationMs: number | null;
  eventsInWindow: number;
  errorsInWindow: number;
}

export interface SourceHealthList {
  events: SourceHealthEvent[];
  sources: SourceHealthSummary[];
  /** The clamped page size the server applied. */
  limit: number;
  /** Older rows exist beyond this window. */
  truncated: boolean;
}

export interface SourceHealthQuery {
  limit?: number;
  sourceCode?: string;
  status?: SourceHealthStatus;
}

export function getAdminSourceHealth(
  query: SourceHealthQuery,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  const params = new URLSearchParams();

  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }

  if (query.sourceCode) {
    params.set("sourceCode", query.sourceCode);
  }

  if (query.status) {
    params.set("status", query.status);
  }

  const queryString = params.toString();

  return adminGet<SourceHealthList>(
    "/api/admin/source-health" + (queryString ? "?" + queryString : ""),
    accessToken,
    fetchImpl,
  );
}

/**
 * Queue and worker administration.
 *
 * Read a queue, re-arm a dead-lettered job, or run a worker batch. The triggers
 * are session + requireAdmin on the server; the browser never holds
 * WORKER_TRIGGER_SECRET, which is what the /api/worker/* routes require.
 */
export type AdminQueueName = "ingestion_jobs" | "fit_analysis_jobs" | "company_registry_lookup_jobs";

export const ADMIN_QUEUE_LABELS: Record<AdminQueueName, string> = {
  ingestion_jobs: "Ingestion",
  fit_analysis_jobs: "Fit analysis",
  company_registry_lookup_jobs: "Company registry",
};

export type AdminQueueJobStatus = "pending" | "leased" | "done" | "failed";

export interface AdminQueueCounts {
  pending: number;
  leased: number;
  done: number;
  failed: number;
}

export interface AdminDeadLetterJob {
  id: string;
  /** A queue-specific one-line identity, so this is not just a uuid on screen. */
  label: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string | null;
}

export interface AdminQueueSummary {
  queue: AdminQueueName;
  counts: AdminQueueCounts;
  /** How long the oldest pending row has been waiting. Null when nothing is pending. */
  oldestPendingAt: string | null;
  deadLetters: AdminDeadLetterJob[];
}

export interface AdminQueuesOverview {
  queues: AdminQueueSummary[];
  deadLetterLimit: number;
}

export interface AdminQueueRetryResult {
  queue: AdminQueueName;
  jobId: string;
  rearmed: boolean;
}

/** Keep in sync with server/admin/workerTasks.ts ADMIN_WORKER_TASKS. */
export type AdminWorkerTaskName =
  | "ingestion"
  | "fit-analysis"
  | "classify-messages"
  | "match-messages"
  | "anti-ghosting"
  | "mailbox-poll"
  | "calendar-sync";

export const ADMIN_WORKER_TASKS: readonly AdminWorkerTaskName[] = [
  "match-messages",
  "classify-messages",
  "fit-analysis",
  "ingestion",
  "anti-ghosting",
  "mailbox-poll",
  "calendar-sync",
];

/**
 * Ordered cheapest-and-safest first, which is also the order the buttons render
 * in: linking costs nothing, classification and fit cost model calls, ingestion
 * spends third-party quota, and the two Google tasks can be unconfigured.
 */
export const ADMIN_WORKER_TASK_LABELS: Record<AdminWorkerTaskName, string> = {
  "match-messages": "Match messages",
  "classify-messages": "Classify messages",
  "fit-analysis": "Fit analysis",
  ingestion: "Ingestion fetch",
  "anti-ghosting": "Anti-ghosting sweep",
  "mailbox-poll": "Mailbox poll",
  "calendar-sync": "Calendar sync",
};

export interface AdminWorkerTaskResult {
  task: AdminWorkerTaskName;
  /** The runner's own counters. Shape differs per task, so it stays open. */
  result: Record<string, unknown>;
}

export function getAdminQueues(accessToken: string, fetchImpl: typeof fetch = fetch) {
  return adminGet<AdminQueuesOverview>("/api/admin/queues", accessToken, fetchImpl);
}

export function retryAdminQueueJob(
  queue: AdminQueueName,
  jobId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  const path =
    "/api/admin/queues/" + encodeURIComponent(queue) + "/" + encodeURIComponent(jobId) + "/retry";

  return adminSend<AdminQueueRetryResult>(path, accessToken, { method: "POST" }, fetchImpl);
}

export function runAdminWorkerTask(
  task: AdminWorkerTaskName,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  const path = "/api/admin/worker/" + encodeURIComponent(task);

  return adminSend<AdminWorkerTaskResult>(path, accessToken, { method: "POST" }, fetchImpl);
}
