import { getSupabaseBrowserClient } from "./supabaseClient";

/* ------------------------------------------------------------------------- *
 * Task A1 — live discovery, for the "Fetch latest jobs" button.
 *
 * The button used to call POST /api/opportunities/refresh, which drained the
 * server's ingestion_jobs queue. Nothing in this repository ever put a job in
 * that queue from the UI, so the call was a no-op: the spinner turned, the batch
 * ran over an empty queue, and the list did not change. This calls the on-demand
 * intake instead — the same runIntake the discover_live_jobs MCP tool uses.
 *
 * The old client for that route has been REMOVED rather than kept "just in case".
 * The scheduled ingestion path has its own server-side callers in
 * server/schedulerTasks.ts; no browser code needs to drain a queue, and a second
 * refresh entry point in this module is exactly the ambiguity the panel now
 * resolves by naming job search and ranking separately.
 * ------------------------------------------------------------------------- */

/**
 * One source's contribution to a fan-out run. Mirrors the server's
 * IntakeSourceSummary, including entries for sources that FAILED — the UI needs
 * to name what was unavailable, not merely count what worked.
 */
export interface DiscoverySourceSummary {
  sourceCode: string;
  displayName: string;
  /** The source's own attribution, which its terms require to travel with its data. */
  attribution: string;
  status: "ok" | "failed";
  error?: string;
  search: string | null;
  received: number;
  ingested: number;
  created: number;
  updated: number;
  skippedByAdapter: number;
  newVacancyIds: string[];
  trustStatusCounts: Record<string, number>;
  durationMs: number;
}

export interface LiveDiscoveryResult {
  /** Aggregate across every source that ran. */
  received: number;
  ingested: number;
  created: number;
  updated: number;
  /** Union of every source's new ids, so the list can mark all of them. */
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
  /** Sources that were skipped, so partial success is visible rather than silent. */
  failedSources: number;
  sources: DiscoverySourceSummary[];
}

export type DiscoverLiveJobsOutcome =
  | { kind: "success"; result: LiveDiscoveryResult }
  /** Accepted and still running when the client's polling budget ran out. */
  | { kind: "pending"; message: string }
  | { kind: "error"; message: string };

/**
 * The server's monitor payload for GET /api/intake/discover: the candidate's latest
 * refresh row, reduced to what the button needs.
 */
export interface IntakeRefreshStatus {
  status: "idle" | "pending" | "leased" | "done" | "failed";
  running: boolean;
  result: LiveDiscoveryResult | null;
  lastError: string | null;
  updatedAt: string | null;
}

export type IntakeMonitorOutcome =
  | { kind: "success"; status: IntakeRefreshStatus }
  | { kind: "error"; message: string };

export interface DiscoverLiveJobsDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
  /** Injected in tests so polling does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How many monitor reads before reporting the work as still running. */
  maxPolls?: number;
  /** Delay between monitor reads, in milliseconds. */
  pollIntervalMs?: number;
}


const DISCOVER_ENDPOINT = "/api/intake/discover";
const DISCOVERY_FAILED = "Could not fetch new jobs. Please try again.";

/**
 * Shown when the work is accepted but has not settled inside the polling budget. The
 * drain runs on the scheduler's cadence, so a couple of minutes is a normal wait rather
 * than a fault - the copy says so instead of implying a failure.
 */
const DISCOVERY_PENDING =
  "Your job search is running in the background. New jobs will appear as soon as it finishes.";

/**
 * THE FOREGROUND BUDGET IS DELIBERATELY SHORT. The drain runs on the scheduler's
 * cadence, so a refresh routinely takes longer than anyone should stare at a spinner:
 * the button watches for about twelve seconds (an immediate read plus four more), then
 * hands off to the panel's persistent indicator, which keeps watching without blocking
 * the page and survives navigating away.
 */
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLLS = 4;

/**
 * How often the PANEL polls the monitor once the button has handed off. Exported so the
 * component and this module cannot disagree about the cadence.
 */
export const BACKGROUND_MONITOR_INTERVAL_MS = 5_000;

/**
 * Never throws — every outcome resolves to one shape the panel can render,
 * matching lib/bulkApply.ts and the rest of this directory.
 */
export async function discoverLiveJobs(deps: DiscoverLiveJobsDeps = {}): Promise<DiscoverLiveJobsOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  if (!accessToken) {
    return { kind: "error", message: SESSION_EXPIRED };
  }

  const authHeader = { Authorization: `Bearer ${accessToken}` };

  // 1. QUEUE THE WORK. The server answers 202 with a queued status: it no longer holds
  //    the request open for a sequential fan-out that can take minutes, so the POST's
  //    own body cannot be the answer.
  let response: Response;
  try {
    response = await fetchImpl(DISCOVER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
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
    // The server's own copy is used where it says something actionable (an unknown
    // source, say) rather than a generic failure.
    const serverMessage = await readServerError(response);
    return { kind: "error", message: serverMessage ?? DISCOVERY_FAILED };
  }

  // 2. MONITOR THE BACKGROUND WORK, BRIEFLY. The drain runs on the scheduler's cadence,
  //    so a refresh still running after a few seconds is normal rather than slow; watching
  //    it to completion here would hold the candidate on a spinner for minutes.
  for (let attempt = 0; attempt <= maxPolls; attempt += 1) {
    // The FIRST read happens immediately: a fast drain can finish before the browser has
    // even painted the spinner, and waiting three seconds to discover that is pointless.
    if (attempt > 0) {
      await sleep(pollIntervalMs);
    }

    const monitor = await readIntakeRefreshStatus({ fetchImpl, getAccessToken });

    if (monitor.kind === "error") {
      return { kind: "error", message: monitor.message };
    }

    const status = monitor.status;

    if (status.running) {
      continue;
    }

    if (status.status === "failed") {
      return { kind: "error", message: status.lastError ?? DISCOVERY_FAILED };
    }

    if (status.result) {
      return { kind: "success", result: status.result };
    }

    // Settled with nothing to show: idle, or a finished row with no stored summary.
    return { kind: "error", message: DISCOVERY_FAILED };
  }

  // Still running when the FOREGROUND budget ran out. Honest rather than a failure, and a
  // handoff rather than an ending: the panel's indicator keeps watching from here.
  return { kind: "pending", message: DISCOVERY_PENDING };
}

/**
 * ONE read of the monitor, for callers that are not the button: the panel reads it on
 * mount to learn whether a refresh started on an earlier visit is still running, and
 * polls it while its background indicator is showing.
 *
 * Never throws, matching discoverLiveJobs: a failed read is returned as a value, because
 * a transient network blip must not be presented as the refresh itself failing.
 */
export async function readIntakeRefreshStatus(
  deps: DiscoverLiveJobsDeps = {},
): Promise<IntakeMonitorOutcome> {
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

  try {
    const response = await fetchImpl(DISCOVER_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status === 401) {
      return { kind: "error", message: SESSION_EXPIRED };
    }

    if (!response.ok) {
      return { kind: "error", message: DISCOVERY_FAILED };
    }

    return { kind: "success", status: (await response.json()) as IntakeRefreshStatus };
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
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
  const total = result.sources.length;
  const plural = total === 1 ? "source" : "sources";
  const unavailable =
    result.failedSources > 0 ? ` ${result.failedSources} of ${total} ${plural} couldn't be reached.` : "";

  // Every source failing is NOT "no new jobs": nothing was fetched at all, and
  // reporting it as a quiet zero would hide a total outage behind a calm
  // sentence. Checked first, for that reason.
  if (total > 0 && result.failedSources === total) {
    const names = result.sources.map((source) => source.displayName).join(", ");
    return `Couldn't reach ${names}. Nothing was fetched — please try again later.`;
  }

  if (result.created > 0) {
    const noun = result.created === 1 ? "job" : "jobs";
    const added = `${result.created} new ${noun} added`;

    if (result.fitAnalyzed === result.created) {
      return `${added} and scored.${unavailable}`;
    }

    if (result.fitAnalyzed > 0) {
      // Says exactly how many are ranked and how many are not. "5 scored"
      // alone would leave a candidate wondering why 11 of their 16 new jobs
      // are missing from the top of the list.
      return `${added}. ${result.fitAnalyzed} scored; ${result.fitPending} still queued for scoring.${unavailable}`;
    }

    // Nothing scored: the jobs are real but unranked, so they sort last and the
    // UI is still hoisting them. Saying "scored" here would be false.
    return `${added}. They aren't scored yet, so they're shown at the top until their fit analysis runs.${unavailable}`;
  }

  if (result.updated > 0) {
    return `No new jobs — ${result.updated} existing listing${result.updated === 1 ? "" : "s"} refreshed.${unavailable}`;
  }

  if (result.received === 0) {
    return `No jobs came back from the ${plural} this time. Try again later.${unavailable}`;
  }

  return total === 1
    ? `No new jobs right now. This source republishes the same listings until it has new ones.${unavailable}`
    : `No new jobs right now. These sources republish the same listings until they have new ones.${unavailable}`;
}

/**
 * Shared by the two discovery calls above. A missing or unreadable session is reported
 * as a value rather than thrown, so the panel renders one shape for every outcome.
 */
const SESSION_EXPIRED = "Your session has expired. Please sign in again.";

async function defaultGetAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

