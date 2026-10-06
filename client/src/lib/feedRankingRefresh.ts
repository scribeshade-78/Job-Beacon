import { getSupabaseBrowserClient } from "./supabaseClient";

/**
 * Client for POST /api/opportunities/ranking-refresh — the MANUAL preference
 * ranking refresh.
 *
 * THIS IS NOT THE "FETCH LATEST JOBS" BUTTON. That one discovers new postings
 * from a provider. This one coordinates the LOCAL derived data the ranked feed
 * needs (posting evidence tokens, this candidate's qualifier generation, this
 * candidate's role matches). It never contacts a provider, spends money or
 * submits anything.
 *
 * THE SERVER DOES BOUNDED WORK PER CALL. A cold corpus cannot finish inside one
 * request, so this polls a bounded number of times with backoff and stops on
 * completion, the time cap, unmount (AbortSignal) or a terminal failure. It never
 * spins: every wait is a real delay, the cap is enforced locally, and the server
 * route carries its own deadline and rate limit.
 */

export type RankingRefreshOutcome = "no_target_roles" | "running" | "succeeded" | "failed";

export interface RankingRefreshResult {
  outcome: RankingRefreshOutcome;
  phase: string;
  state: string;
  identity: string | null;
  attempts: number;
  retryable: boolean;
  lastError: string | null;
  deadlineReached: boolean;
}

export type RankingRefreshRequest =
  | { kind: "success"; result: RankingRefreshResult }
  | { kind: "error"; message: string; retryable: boolean };

export type RankingRefreshRun =
  | { kind: "done"; result: RankingRefreshResult }
  | { kind: "timeout"; result: RankingRefreshResult | null }
  | { kind: "error"; message: string; retryable: boolean };

export interface RankingRefreshDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

export interface RunRankingRefreshOptions extends RankingRefreshDeps {
  /** Explicit retry / role-change trigger. Continuation polls leave this false. */
  force?: boolean;
  /** Called after every poll, so a panel can show progress without waiting. */
  onUpdate?: (result: RankingRefreshResult) => void;
  /** Unmount / navigation: aborts the wait between polls. */
  signal?: AbortSignal;
  /** Injectable clock and sleep, for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxDurationMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export const RANKING_REFRESH_MAX_MS = 60_000;
export const RANKING_REFRESH_INITIAL_DELAY_MS = 1_500;
export const RANKING_REFRESH_MAX_DELAY_MS = 3_000;

const SESSION_EXPIRED = "Your session has expired. Please sign in again.";
const GENERIC_FAILURE = "Could not update your preference ranking. Please try again.";
const TIMEOUT_MESSAGE = "Preference ranking is taking longer than expected.";

async function defaultGetAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

/** A single bounded server call. Never throws. */
export async function requestRankingRefresh(
  deps: RankingRefreshDeps = {},
  force = false,
): Promise<RankingRefreshRequest> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;

  let accessToken: string | null;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { kind: "error", message: SESSION_EXPIRED, retryable: false };
  }

  if (!accessToken) {
    return { kind: "error", message: SESSION_EXPIRED, retryable: false };
  }

  let response: Response;
  try {
    response = await fetchImpl("/api/opportunities/ranking-refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
      body: JSON.stringify({ force }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server.", retryable: true };
  }

  if (response.status === 401) {
    return { kind: "error", message: SESSION_EXPIRED, retryable: false };
  }

  if (response.status === 429) {
    return {
      kind: "error",
      message: "You've refreshed your ranking recently. Please wait a moment and try again.",
      retryable: true,
    };
  }

  if (!response.ok) {
    return { kind: "error", message: GENERIC_FAILURE, retryable: response.status >= 500 };
  }

  try {
    return { kind: "success", result: (await response.json()) as RankingRefreshResult };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE, retryable: true };
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls the refresh route until it settles or the local cap is reached.
 *
 * THE FIRST CALL MAY FORCE, CONTINUATIONS NEVER DO. force is only true on the
 * caller's trigger (a role save, or the feed noticing a non-current state); every
 * retry poll passes false, so a save does not repeatedly re-arm generation after
 * generation and a failure is not retried behind the candidate's back.
 */
export async function runRankingRefresh(
  options: RunRankingRefreshOptions = {},
): Promise<RankingRefreshRun> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const maxDurationMs = options.maxDurationMs ?? RANKING_REFRESH_MAX_MS;
  const maxDelayMs = options.maxDelayMs ?? RANKING_REFRESH_MAX_DELAY_MS;
  const deadline = now() + maxDurationMs;

  let force = options.force === true;
  let delay = options.initialDelayMs ?? RANKING_REFRESH_INITIAL_DELAY_MS;
  let lastResult: RankingRefreshResult | null = null;

  // Bounded by the deadline AND by one poll per loop iteration; the loop cannot
  // spin because every non-terminal iteration sleeps first.
  while (now() < deadline) {
    if (options.signal?.aborted) {
      return { kind: "error", message: "Cancelled", retryable: true };
    }

    const attempt = await requestRankingRefresh(options, force);

    if (attempt.kind === "error") {
      return attempt;
    }

    lastResult = attempt.result;
    options.onUpdate?.(attempt.result);

    if (attempt.result.outcome === "succeeded" || attempt.result.outcome === "no_target_roles") {
      return { kind: "done", result: attempt.result };
    }

    if (attempt.result.outcome === "failed") {
      // A terminal workflow failure is a RESULT, not a transport error; the panel
      // renders it as retryable without ever implying the save itself failed.
      return { kind: "done", result: attempt.result };
    }

    // outcome === "running": continue WITHOUT force after a bounded backoff.
    force = false;

    if (now() + delay >= deadline) {
      break;
    }

    try {
      await sleep(delay, options.signal);
    } catch {
      return { kind: "error", message: "Cancelled", retryable: true };
    }

    delay = Math.min(Math.round(delay * 1.5), maxDelayMs);
  }

  return { kind: "timeout", result: lastResult };
}

/** The one line a panel shows for a refresh result. */
export function describeRankingRefresh(result: RankingRefreshResult): string {
  if (result.outcome === "succeeded") {
    return "Preference ranking is up to date.";
  }

  if (result.outcome === "no_target_roles") {
    return "Choose your target roles to rank jobs by your preferences.";
  }

  if (result.outcome === "failed") {
    return result.lastError
      ? "Preference ranking could not be updated: " + result.lastError
      : "Preference ranking could not be updated.";
  }

  return result.phase === "indexing"
    ? "Preparing posting evidence for ranking\u2026"
    : "Ranking your jobs by your preferences\u2026";
}
