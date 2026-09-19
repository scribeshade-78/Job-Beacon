import { getSupabaseBrowserClient } from "./supabaseClient";

/* ------------------------------------------------------------------------- *
 * Task A1 — live discovery, for the "Fetch latest jobs" button.
 *
 * The button used to call refreshOpportunities() below, which drains the
 * server's ingestion_jobs queue. Nothing in this repository ever puts a job in
 * that queue, so that call was a no-op: the spinner turned, the batch ran over
 * an empty queue, and the list did not change. This calls the on-demand intake
 * instead — the same runIntake the discover_live_jobs MCP tool uses.
 *
 * refreshOpportunities is kept (and still used by nothing else) because
 * draining that queue remains the correct behaviour for a scheduled worker;
 * it just is not something a candidate's button can usefully do.
 * ------------------------------------------------------------------------- */

export interface LiveDiscoveryResult {
  sourceCode: string;
  displayName: string;
  /** The attribution the source's terms require to travel with its data. */
  attribution: string;
  search: string | null;
  /** Listings the source returned, before filtering. */
  received: number;
  /** Listings written through the ingestion path. */
  ingested: number;
  /** Of those, how many did not exist before — the only number that means "new". */
  created: number;
  updated: number;
  /** Vacancy ids created by this call, so the list can mark them. */
  newVacancyIds: string[];
  /** How many of the new vacancies were scored with a priority before this response. */
  fitAnalyzed: number;
  /** How many were left queued for the scheduled fit worker. */
  fitPending: number;
  /** True when the scoring budget ran out rather than the work finishing. */
  fitStoppedOnDeadline: boolean;
  fitError: string | null;
  skippedByAdapter: number;
  trustStatusCounts: Record<string, number>;
  durationMs: number;
}

export type DiscoverLiveJobsOutcome =
  | { kind: "success"; result: LiveDiscoveryResult }
  | { kind: "error"; message: string };

export interface DiscoverLiveJobsDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

const DISCOVERY_FAILED = "Could not fetch new jobs. Please try again.";

/**
 * Never throws — every outcome resolves to one shape the panel can render,
 * matching lib/bulkApply.ts and the rest of this directory.
 */
export async function discoverLiveJobs(deps: DiscoverLiveJobsDeps = {}): Promise<DiscoverLiveJobsOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (!accessToken) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/intake/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (response.status === 429) {
    return { kind: "error", message: "You've fetched jobs recently. Please wait a few minutes and try again." };
  }

  if (!response.ok) {
    // The server's own copy is used where it says something actionable (a
    // switched-off source, say) rather than a generic failure.
    const serverMessage = await readServerError(response);
    return { kind: "error", message: serverMessage ?? DISCOVERY_FAILED };
  }

  try {
    return { kind: "success", result: (await response.json()) as LiveDiscoveryResult };
  } catch {
    return { kind: "error", message: DISCOVERY_FAILED };
  }
}

async function readServerError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * The one line a candidate needs after pressing the button.
 *
 * Deliberately explicit about the zero case, which is the normal one: the
 * source returns the same listings until it publishes new ones, so "no new
 * jobs" is a correct answer and must not read as a failure. It also names the
 * "these will rank later" fact, because newly ingested jobs have no fit
 * analysis yet and therefore sort below the scored ones — a candidate who was
 * told "5 new jobs" and saw an unchanged list would rightly think the button
 * was still broken.
 */
export function describeDiscoveryResult(result: LiveDiscoveryResult): string {
  if (result.created > 0) {
    const noun = result.created === 1 ? "job" : "jobs";
    const added = `${result.created} new ${noun} added`;

    if (result.fitAnalyzed === result.created) {
      return `${added} and scored.`;
    }

    if (result.fitAnalyzed > 0) {
      // Says exactly how many are ranked and how many are not. "5 scored"
      // alone would leave a candidate wondering why 11 of their 16 new jobs
      // are missing from the top of the list.
      return `${added}. ${result.fitAnalyzed} scored; ${result.fitPending} still queued for scoring.`;
    }

    // Nothing scored: the jobs are real but unranked, so they sort last and the
    // UI is still hoisting them. Saying "scored" here would be false.
    return `${added}. They aren't scored yet, so they're shown at the top until their fit analysis runs.`;
  }

  if (result.updated > 0) {
    return `No new jobs — ${result.updated} existing listing${result.updated === 1 ? "" : "s"} refreshed.`;
  }

  if (result.received === 0) {
    return "No jobs came back from the source this time. Try again later.";
  }

  return "No new jobs right now. This source republishes the same listings until it has new ones.";
}

/**
 * Client for POST /api/opportunities/refresh — the "Fetch latest jobs"
 * button on the Opportunities page.
 *
 * This is an Express call rather than a direct Supabase write because
 * triggering ingestion is system-initiated privileged work (it reads
 * source_policies / vacancy_sources and writes vacancies), the same reason
 * every other route in lib/admin.ts goes through the server. The candidate
 * only supplies their access token; which sources to poll and how often is
 * decided server-side.
 */

export type IngestionTargetStatus = "fetched" | "skipped_recent" | "skipped_queued" | "failed";

export interface IngestionTargetOutcome {
  sourceCode: string;
  targetKey: string;
  status: IngestionTargetStatus;
  vacanciesFetched: number;
  lastError?: string;
}

export interface IngestionRefreshResult {
  targets: IngestionTargetOutcome[];
  vacanciesFetched: number;
  failed: number;
  skippedRecent: number;
  skippedQueued: number;
}

export type RefreshOpportunitiesResult =
  | { kind: "success"; result: IngestionRefreshResult }
  | { kind: "error"; message: string };

export interface RefreshOpportunitiesDeps {
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real browser session. */
  getAccessToken?: () => Promise<string | null>;
}

const GENERIC_FAILURE = "Could not refresh jobs. Please try again.";
const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

async function defaultGetAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Resolves to a plain result object for every outcome — never throws — so
 * the panel only ever has to render one shape, matching lib/admin.ts and
 * lib/opportunities.ts.
 */
export async function refreshOpportunities(
  deps: RefreshOpportunitiesDeps = {},
): Promise<RefreshOpportunitiesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (!accessToken) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/opportunities/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (response.status === 429) {
    return { kind: "error", message: "You've refreshed recently. Please wait a few minutes and try again." };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_FAILURE };
  }

  try {
    return { kind: "success", result: (await response.json()) as IngestionRefreshResult };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE };
  }
}

/**
 * Turns a batch result into the one line a candidate needs. Deliberately
 * explicit about the "nothing new yet" case: the server's per-target
 * cooldown means a second press legitimately fetches nothing, and silently
 * reporting success would look like the button is broken.
 */
export function describeRefreshResult(result: IngestionRefreshResult): string {
  if (result.failed > 0 && result.vacanciesFetched === 0) {
    return "Could not fetch jobs from any source. Please try again later.";
  }

  if (result.vacanciesFetched === 0) {
    const skipped = result.skippedRecent + result.skippedQueued;
    if (skipped > 0) {
      return "Already up to date — jobs were fetched recently. Check back a little later.";
    }
    return "No new jobs found.";
  }

  const noun = result.vacanciesFetched === 1 ? "job" : "jobs";
  const base = `Fetched ${result.vacanciesFetched} ${noun}.`;

  return result.failed > 0 ? `${base} Some sources could not be reached.` : base;
}
