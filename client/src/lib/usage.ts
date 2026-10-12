/**
 * Phase 2c M6 - the client half of the discovery-surface ledger write.
 *
 * A ROUTE, NOT A BROWSER RPC. candidate_usage_events is service-role-only with no
 * candidate write path, so the client cannot insert into it and must not be able
 * to: this reports what the candidate was shown and lets the server decide. The
 * server takes the candidate id from the verified token, so a forged body can only
 * ever claim the caller's own surfaces.
 *
 * IT STILL NEVER BREAKS THE FEED, BUT IT NO LONGER LIES ABOUT FAILING.
 *
 * The first version ended in an empty `catch {}` and never looked at the response
 * status at all, so a reporting outage was completely invisible: the ledger quietly
 * stopped receiving rows and nothing on either side said so. "Accounting must not
 * break the job list" is a good reason to keep the feed working; it is not a reason
 * to have no idea the accounting is broken.
 *
 * Three things changed, and none of them block the feed:
 *   1. `response.ok` IS CHECKED. A fetch whose body was never read resolves happily
 *      on a 500, so the old code could not have noticed a failure even if it wanted to.
 *   2. ONE retry, because these are transient far more often than not.
 *   3. After FAILURES_BEFORE_NOTICE consecutive failures the candidate is told once.
 *      That matters because discovery usage is an allowance they can run out of, and
 *      silently failing to record it is not a neutral act.
 */

import { showToast } from "../components/ui/use-toast";
import { getSupabaseBrowserClient } from "./supabaseClient";

/** Stable and greppable: an operator should be able to find this without guessing. */
export const DISCOVERY_REPORT_FAILURE_MARKER = "[usage] discovery-surface report failed";

/** Told once, after this many consecutive failures - not on the first blip. */
export const FAILURES_BEFORE_NOTICE = 3;

let consecutiveFailures = 0;
let noticeShown = false;

/** Test seam. The counters are module state by design so they survive across calls. */
export function resetDiscoveryReportState(): void {
  consecutiveFailures = 0;
  noticeShown = false;
}

export async function reportDiscoverySurfaces(
  vacancyIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (vacancyIds.length === 0) {
    return;
  }

  let lastReason = "unknown";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data } = await getSupabaseBrowserClient().auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        // No session is not a failure to report - there is nothing to attribute the
        // usage to, and the candidate is not using the feed at all.
        return;
      }

      const response = await fetchImpl("/api/usage/discovery-surface", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ vacancyIds }),
      });

      if (response.ok) {
        consecutiveFailures = 0;
        return;
      }

      // Read the body so the reason is specific rather than "not ok".
      const detail = await response.text().catch(() => "");
      lastReason = "HTTP " + response.status + (detail ? " " + detail.slice(0, 200) : "");
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  consecutiveFailures += 1;

  console.error(DISCOVERY_REPORT_FAILURE_MARKER, {
    vacancyCount: vacancyIds.length,
    consecutiveFailures,
    reason: lastReason,
  });

  if (consecutiveFailures >= FAILURES_BEFORE_NOTICE && !noticeShown) {
    noticeShown = true;
    showToast({
      title: "We couldn't record today's discovery usage",
      description:
        "Your job list still works. This is our accounting, not your search — we're already retrying, and this notice won't appear again this session.",
      tone: "error",
    });
  }
}
