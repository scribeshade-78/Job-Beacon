import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/status-badge";
import {
  FitSection,
  TrustNoticeBanner,
  autoApplyStatusBadge,
  formatSourceName,
  isPartiallyVerified,
  isUnverifiedSource,
  trustStatusToBadge,
} from "../components/OpportunitySignals";
import {
  listOpportunities,
  type OpportunityFitAnalysis,
  type OpportunitySummary,
  type OpportunityTrustStatus,
  type RankingInfo,
} from "../lib/opportunities";
import { describeBulkApplyResult, submitBulkApply } from "../lib/bulkApply";
import {
  describeBulkApplyButton,
  describeLoadedCount,
  fetchQueueCapability,
  type QueueCapabilityState,
} from "../lib/queueCapability";
import { describeDiscoveryResult, discoverLiveJobs } from "../lib/ingestion";
import { workplaceLabel } from "../lib/opportunityFilters";
import { DEFAULT_SORT, SORT_FIELDS_BY_ID, type SortId } from "../../../shared/opportunityQuery";
import {
  EMPTY_FILTERS,
  countActiveFilters,
  deriveFiltersFromPreferences,
  evaluateSearchPreferenceEligibility,
  filterOpportunitiesByRoleRelevance,
  isEligibleForFeed,
  type OpportunityFilters,
} from "../lib/opportunityQuery";
import { loadCandidatePreferences, type CandidatePreferences } from "../lib/candidatePreferences";
import {
  EMPTY_DECISIONS,
  excludedFromFeed,
  listVacancyDecisions,
  type VacancyDecisions,
} from "../lib/jobDecisions";
import { loadSearchPreferences } from "../lib/searchPreferences";
import { ineligibilityReasonOf } from "../../../shared/eligibilityReason";
import type { SearchPreferences } from "../../../shared/searchPreferences";
import { OpportunityFilterBar } from "./OpportunityFilterBar";
import { InterviewPrepDialog } from "../components/InterviewPrepDialog";
import { showToast } from "../components/ui/use-toast";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { describeRankingRefresh, runRankingRefresh } from "../lib/feedRankingRefresh";
import { formatSalary } from "../lib/opportunities";
import { formatDistanceToNow } from "date-fns";

interface RefreshNotice {
  tone: "info" | "error";
  text: string;
}

interface OpportunitiesPanelProps {
  /**
   * The signed-in candidate, or undefined before the profile resolves. Task I
   * needs it to read the saved preferences that seed the filter state; without
   * it the panel simply starts unfiltered.
   */
  candidateId: string | undefined;
}

export function OpportunitiesPanel({ candidateId }: OpportunitiesPanelProps) {
  const [opportunities, setOpportunities] = useState<OpportunitySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<RefreshNotice | null>(null);
  /**
   * Every vacancy the last fetch created, whether or not it was scored.
   *
   * LABELLING ONLY — it never decides ORDER any more. Newly discovered rows are
   * rendered where the paginated RANKED query places them; a separately ordered
   * slice is deliberately not prepended, because that would imply the combined
   * list is globally ranked when it is two differently ordered slices.
   */
  const [newVacancyIds, setNewVacancyIds] = useState<string[]>([]);
  /**
   * Task I: the filter state is DERIVED from the candidate's saved preferences
   * once those load, and null until then. Null rather than EMPTY_FILTERS so the
   * first query waits for the derivation instead of firing an unfiltered one
   * that the candidate would see flash into a filtered list.
   */
  const [filters, setFilters] = useState<OpportunityFilters | null>(null);
  const [preferences, setPreferences] = useState<CandidatePreferences | null>(null);
  const [sort, setSort] = useState<SortId>(DEFAULT_SORT);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  /**
   * The unified SearchPreferences object — the feed's single source of truth.
   *
   * Null until both tables have been read, so the first query does not fire
   * against a half-known profile. Empty target roles inside a built object still
   * means "no role filter" — the existing behaviour for a candidate who has not
   * chosen any.
   */
  const [searchPreferences, setSearchPreferences] = useState<SearchPreferences | null>(null);

  /**
   * The candidate's own Save/Dismiss rows, loaded once and fed to every list
   * query as an exclusion clause. A failed read leaves EMPTY_DECISIONS: the feed
   * behaves exactly as it did before the feature rather than going blank, and the
   * queue-time gate (server/applications/dismissalGate.ts) is what actually
   * refuses a dismissed vacancy.
   */
  const [decisions, setDecisions] = useState<VacancyDecisions>(EMPTY_DECISIONS);

  /**
   * The ranking state and publication identity of the CURRENT page. Every page
   * must be fetched under one identity; when it changes the pages are reset
   * rather than mixed, because a score ranked under a superseded generation is
   * not on the same scale as the page it would be appended to.
   */
  const [ranking, setRanking] = useState<RankingInfo | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  /**
   * Monotonic request token. Any response whose token is no longer current is
   * OBSOLETE and is ignored, so a slow page can never overwrite a newer one.
   */
  const requestSeq = useRef(0);
  /** Bumped by a Retry control to force the single read effect to run again. */
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * The state of the real ranking refresh this panel requested. Kept apart from
   * "querying" so a refresh is never confused with a page load.
   */
  const [feedRefresh, setFeedRefresh] = useState<
    | { kind: "idle" }
    | { kind: "running"; text: string }
    | { kind: "done"; text: string }
    | { kind: "failed"; text: string; retryable: boolean }
    | { kind: "stalled"; text: string }
  >({ kind: "idle" });
  const feedRefreshAbort = useRef<AbortController | null>(null);
  /** The ranking identity+state a refresh was last started for, so it is not restarted per render. */
  const feedRefreshKey = useRef<string | null>(null);

  const startRankingRefresh = useCallback(
    (force: boolean) => {
      feedRefreshAbort.current?.abort();
      const controller = new AbortController();
      feedRefreshAbort.current = controller;

      setFeedRefresh({ kind: "running", text: "Updating your preference ranking…" });

      void runRankingRefresh({
        force,
        signal: controller.signal,
        onUpdate: (result) => {
          if (!controller.signal.aborted && result.outcome === "running") {
            setFeedRefresh({ kind: "running", text: describeRankingRefresh(result) });
          }
        },
      })
        .then((run) => {
          if (controller.signal.aborted) return;

          if (run.kind === "timeout") {
            // Bounded polling stopped; the candidate can retry. Never a silent loop.
            setFeedRefresh({ kind: "stalled", text: "Still updating your ranking…" });
            return;
          }

          if (run.kind === "error") {
            setFeedRefresh({ kind: "failed", text: run.message, retryable: run.retryable });
            return;
          }

          if (run.result.outcome === "failed") {
            setFeedRefresh({
              kind: "failed",
              text: describeRankingRefresh(run.result),
              retryable: run.result.retryable,
            });
            return;
          }

          setFeedRefresh({ kind: "done", text: describeRankingRefresh(run.result) });
          // Re-read page one so the rows reflect the freshly derived ranking.
          setReloadToken((value) => value + 1);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setFeedRefresh({ kind: "failed", text: "Could not update your ranking.", retryable: true });
          }
        });
    },
    [],
  );

  useEffect(() => () => feedRefreshAbort.current?.abort(), []);

  /**
   * THE ONE TRIGGER. A refresh is requested ONLY when the loaded rows say the
   * ranking is updating or unavailable, and only once per (identity, state): a
   * page of pagination or a re-render never restarts it. It becomes current after
   * the reload, which resets the key, so the loop terminates.
   */
  useEffect(() => {
    const state = ranking?.state;

    if (state !== "updating" && state !== "unavailable") {
      feedRefreshKey.current = null;
      return;
    }

    if (feedRefresh.kind === "running" || feedRefresh.kind === "stalled") {
      return;
    }

    const key = (ranking?.identity ?? "") + ":" + state;

    if (feedRefreshKey.current === key) {
      return;
    }

    feedRefreshKey.current = key;
    startRankingRefresh(false);
  }, [ranking?.state, ranking?.identity, feedRefresh.kind, startRankingRefresh]);

  // True only while a filter/sort change is re-reading, so a control the
  // candidate just touched does not blank the list back to a loading screen.
  const [querying, setQuerying] = useState(false);
  /**
   * The vacancy whose interview prep is open, or null when the dialog is
   * closed. Holding the whole summary rather than just an id lets the dialog
   * title name the role without a second lookup.
   */
  const [prepVacancy, setPrepVacancy] = useState<OpportunitySummary | null>(null);
  const [bulkApplying, setBulkApplying] = useState(false);
  /**
   * Whether ANY source can carry an application, read from the server because
   * source_policies is not readable by a signed-in client. The bulk action is
   * unavailable without it, and the panel must be able to say whether that is
   * because the product cannot do it or because the check itself failed.
   */
  const [capability, setCapability] = useState<QueueCapabilityState>({ kind: "loading" });

  const loadCapability = useCallback(async () => {
    setCapability({ kind: "loading" });
    setCapability(await fetchQueueCapability());
  }, []);

  useEffect(() => {
    void loadCapability();
  }, [loadCapability]);

  useEffect(() => {
    if (!candidateId) {
      // No candidate id means no preferences to read them with; the panel still
      // works, with an empty (unfiltered) filter set.
      setFilters({ ...EMPTY_FILTERS });
      return;
    }

    let cancelled = false;

    loadCandidatePreferences(getSupabaseBrowserClient(), candidateId).then((result) => {
      if (cancelled) return;

      if (result.kind === "success") {
        setPreferences(result.preferences);
        // SMART INHERITANCE: the starting filter state, derived rather than
        // asked for a second time. The bar labels whichever of these the
        // candidate has not changed yet as "from your preferences".
        setFilters(deriveFiltersFromPreferences(result.preferences));
      } else {
        // A preferences failure must not hide the list: the seeded filters and
        // the standing exclusions are conveniences, and an empty filter set
        // with the error shown is the honest fallback.
        setPreferencesError(result.message);
        setFilters({ ...EMPTY_FILTERS });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  /**
   * The unified SearchPreferences object — the feed's relevance input.
   *
   * Read here rather than inside listOpportunities because the ROLE filter is
   * applied to the RENDERED rows while the query keeps paging on the raw rows.
   * Filtering that inside the query would make the offset a count of returned
   * (filtered) rows, so the next page would re-read or skip database rows. The
   * work-mode, salary and exclusion halves of the same object ARE applied to the
   * query, as clauses (see applySearchPreferenceConstraints).
   */
  useEffect(() => {
    if (!candidateId) {
      setSearchPreferences(null);
      return;
    }

    let cancelled = false;

    loadSearchPreferences(getSupabaseBrowserClient(), candidateId).then((result) => {
      if (cancelled) return;
      setSearchPreferences(result.kind === "success" ? result.searchPreferences : null);
    });

    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  // Loaded once: these are the candidate's own rows and no other surface writes
  // them while the feed is open.
  useEffect(() => {
    let cancelled = false;

    listVacancyDecisions(getSupabaseBrowserClient()).then((result) => {
      if (cancelled || result.kind !== "success") return;
      setDecisions(result.decisions);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The ONE place the list is read, and the reason filters and sort are
   * dependencies rather than state the callers have to remember to re-apply.
   *
   * Task I made the filtering and the ordering SERVER-SIDE, so a page now holds
   * up to a full page of matches rather than a filtered subset of whatever rows
   * happened to be loaded.
   *
   * THE TARGET-ROLE FILTER IS THE ONE EXCEPTION, and it narrows what is
   * RENDERED rather than the query (see visibleOpportunities). It has to: the
   * relevance rule is the tokenized matcher in lib/roleTaxonomy.ts, which
   * PostgREST cannot express, and filtering inside the query would turn the
   * offset into a count of filtered rows and corrupt paging. The state below
   * therefore keeps the RAW page, and the offset still counts database rows.
   */
  useEffect(() => {
    if (filters === null) return;

    let cancelled = false;
    const seq = ++requestSeq.current;
    setQuerying(true);

    listOpportunities(getSupabaseBrowserClient(), {
      filters,
      searchPreferences,
      sort,
      // Dismissal wins over a save (jobDecisions.ts), so this is dismissed ids
      // only. Applied as a query clause so paging still counts real rows.
      excludeVacancyIds: excludedFromFeed(decisions),
    }).then((result) => {
      // Obsolete responses are ignored: a token from an older request (a previous
      // filter, or a load-more this read superseded) must not overwrite the newer
      // result, and must not mix pages from two ranking generations.
      if (cancelled || seq !== requestSeq.current) return;

      setQuerying(false);
      setLoading(false);

      if (result.kind === "success") {
        setOpportunities(result.opportunities);
        setHasMore(result.hasMore);
        setTotalCount(result.totalCount);
        setRanking(result.ranking);
        setError(null);
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filters, searchPreferences, sort, decisions, reloadToken]);

  /**
   * Loads the next page. Paging is offset-based from the loaded row count.
   *
   * ONE IDENTITY PER LIST. The page is fetched under the same filters, exclusions
   * and sort as page one; if the ranking identity moved while it loaded, the page
   * is DISCARDED and replaced with the fresh first page rather than appended, so
   * two generations are never presented as one ordered list.
   */
  async function loadMore() {
    setLoadingMore(true);
    const seq = ++requestSeq.current;
    const expectedIdentity = ranking?.identity ?? null;

    const result = await listOpportunities(getSupabaseBrowserClient(), {
      offset: opportunities?.length ?? 0,
      // The same filters, exclusions and sort as the first page. A page fetched
      // under different clauses would be a second, silently different result set
      // appended to the first.
      filters: filters ?? EMPTY_FILTERS,
      searchPreferences,
      sort,
      excludeVacancyIds: excludedFromFeed(decisions),
    });

    setLoadingMore(false);

    if (seq !== requestSeq.current) {
      // A newer request owns the list now; this page is obsolete.
      return;
    }

    if (result.kind !== "success") {
      setError(result.message);
      return;
    }

    if (expectedIdentity !== null && result.ranking.identity !== expectedIdentity) {
      // The applicable generation changed. Reset to the fresh page instead of
      // mixing rows scored under different identity.
      setOpportunities(result.opportunities);
      setHasMore(result.hasMore);
      setTotalCount(result.totalCount);
      setRanking(result.ranking);
      return;
    }

    setOpportunities((prev) => [...(prev ?? []), ...result.opportunities]);
    setHasMore(result.hasMore);
    setTotalCount(result.totalCount);
    setRanking(result.ranking);
  }

  /**
   * Fetches live jobs server-side, then re-reads the list so they appear
   * without a page reload.
   *
   * This calls /api/intake/discover, which runs the same on-demand intake as
   * the discover_live_jobs MCP tool. It previously called
   * /api/opportunities/refresh, which drains an ingestion queue nothing ever
   * fills — the button span and did nothing, which is exactly what it looked
   * like.
   *
   * The progress notice is cleared once the toast has the result, so the two
   * cannot disagree on screen.
   */
  async function handleRefresh() {
    setRefreshing(true);
    setRefreshNotice(null);
    setNewVacancyIds([]);

    try {
      const outcome = await discoverLiveJobs();

      if (outcome.kind === "error") {
        setRefreshNotice({ tone: "error", text: outcome.message });
        showToast({ title: outcome.message, tone: "error" });
        return;
      }

      // RELOAD THROUGH THE PAGINATED RANKED QUERY. The previously hoisted,
      // independently ordered "newly discovered" slice is deliberately gone: it
      // implied the combined list was globally ranked when it was two differently
      // ordered slices stacked together. Newly discovered rows now appear where
      // the ranked query places them, and the "New" badge still marks them.
      const seq = ++requestSeq.current;

      const reloaded = await listOpportunities(getSupabaseBrowserClient(), {
        // The SAME filters, exclusions and sort the list is currently showing.
        // Re-reading page 1 unfiltered here would silently replace a filtered list
        // with an unfiltered one the moment somebody pressed "Fetch latest jobs".
        filters: filters ?? EMPTY_FILTERS,
        searchPreferences,
        sort,
        excludeVacancyIds: excludedFromFeed(decisions),
      });

      if (seq !== requestSeq.current) {
        // A newer request (a filter change, or another refresh) owns the list.
        return;
      }

      setNewVacancyIds(outcome.result.newVacancyIds);

      const text = describeDiscoveryResult(outcome.result);

      // The notice is set on SUCCESS as well as on failure, and that is the
      // fix for "the button does nothing". The toast was previously the entire
      // success signal, and a toast is transient — while `created: 0` is the
      // NORMAL outcome (one source returns the same listings until it publishes
      // new ones), so on the common path the list came back byte-identical and
      // a candidate who glanced away for the few seconds the toast lived saw no
      // change at all. The notice persists until the next attempt starts.
      setRefreshNotice({ tone: "info", text });
      // "No new jobs" is a correct answer, not a failure, and the tone says so.
      showToast({ title: text, tone: outcome.result.created > 0 ? "success" : "default" });

      if (reloaded.kind === "success") {
        setOpportunities(reloaded.opportunities);
        setHasMore(reloaded.hasMore);
        setTotalCount(reloaded.totalCount);
        setRanking(reloaded.ranking);
        setError(null);
      } else {
        setError(reloaded.message);
      }
    } catch (error) {
      // Nothing in this path is expected to throw, but `void handleRefresh()`
      // would turn a throw into an unhandled rejection AND strand the button on
      // "Fetching…" — disabled, with no way back except a reload. Surfaced
      // rather than swallowed, for the same reason.
      const message = error instanceof Error ? error.message : String(error);
      setRefreshNotice({ tone: "error", text: `Could not fetch new jobs: ${message}` });
      showToast({ title: "Could not fetch new jobs.", tone: "error" });
    } finally {
      setRefreshing(false);
    }
  }

  const refreshButton = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void handleRefresh()}
      disabled={refreshing}
      aria-busy={refreshing}
    >
      <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
      {refreshing ? "Fetching…" : "Fetch latest jobs"}
    </Button>
  );

  /**
   * NO CLIENT-SIDE WORKPLACE FILTERING. Work mode is a server-side clause on
   * remote_type; running the predicate over the fetched page as well would narrow
   * the same rows twice. The separately fetched discovered slice is gone, and
   * with it the one remaining use of that predicate.
   */

  /**
   * The rows actually rendered.
   *
   * THE READY PATH HAS NO RENDER-TIME ROLE FILTER. When ranking is current the
   * ranked query already enforced canonical-role relevance from the
   * authoritative materialised matches, so the fetched page IS the answer;
   * filtering it again here would be a second, weaker matcher.
   *
   * THE FALLBACK KEEPS THE EXISTING FILTER, explicitly confined to it: without
   * applicable coverage SQL cannot enforce relevance, so the TypeScript matcher
   * decides what is shown. That it filters the LOADED page rather than the
   * database — and is therefore less complete than the ranked path — is reported
   * in the UI rather than hidden.
   */
  const rankingCurrent = ranking?.state === "current";

  const visibleOpportunities = useMemo(() => {
    const merged = opportunities ?? [];

    if (rankingCurrent) {
      return merged;
    }

    return filterOpportunitiesByRoleRelevance(merged, searchPreferences);
  }, [opportunities, searchPreferences, rankingCurrent]);

  /**
   * What the feed's own constraints are hiding from the loaded page, so an
   * exclusion is visible rather than silent. The server already applied work
   * mode, salary and exclusions to this page, so on the main list this reports
   * the role mismatches the client filter removed; the same ledger decides the
   * by-id path in handleRefresh.
   */
  const hiddenByPreferences = useMemo(() => {
    if (!searchPreferences) {
      return [] as string[];
    }

    const reasons = new Set<string>();

    for (const opportunity of opportunities ?? []) {
      // An unstated location does not hide a job from the feed (manual browsing
      // stays available); the server gate is what refuses to queue it.
      if (isEligibleForFeed(searchPreferences, opportunity)) {
        continue;
      }

      reasons.add(ineligibilityReasonOf(evaluateSearchPreferenceEligibility(searchPreferences, opportunity).gates));
    }

    return [...reasons];
  }, [opportunities, searchPreferences]);

  const activeFilterCount = filters === null ? 0 : countActiveFilters(filters);

  /**
   * Mini-Phase 6: real enqueue. The route runs every requested vacancy through
   * planApplication, so the eligibility gates decide what is queued — this
   * button cannot bypass them, and with no adapter registered for any source
   * the honest answer today is "0 queued".
   *
   * The toast tone follows the outcome rather than the HTTP status: a 200 that
   * queued nothing is not a success, and reporting it as one would be the
   * exact dishonesty the rest of this panel avoids.
   */
  async function handleBulkApply() {
    const vacancyIds = visibleOpportunities.map((opportunity) => opportunity.id);

    if (vacancyIds.length === 0) {
      return;
    }

    // NO SECOND FETCH, AND NO POINTLESS POST. The capability is already known,
    // so a click that cannot succeed must not reach the network — the server
    // would only re-derive the same refusal. If capability CHANGED since the
    // read (a policy was revoked moments ago), the server's own per-vacancy
    // gates are authoritative and the POST below still reports the truth.
    if (bulkApplyButton.blocked) {
      return;
    }

    setBulkApplying(true);
    const outcome = await submitBulkApply(vacancyIds);

    if (outcome.kind === "error") {
      setBulkApplying(false);
      showToast({ title: outcome.message, tone: "error" });
      return;
    }

    const { text, tone } = describeBulkApplyResult(outcome.result);
    showToast({ title: text, tone });

    // Clear the filters and re-read, so the list reflects what just happened
    // instead of leaving the user on a view they have to reason about. The
    // re-read is not issued here: a fresh filter object re-runs the query
    // effect, which is the single place the list is read.
    setFilters({ ...EMPTY_FILTERS });
    setBulkApplying(false);
  }

  /**
   * Derived once, used by the handler (to refuse the click) and by the button
   * (for its label, availability and explanation), so the two cannot disagree
   * about whether the action is available.
   */
  const bulkApplyButton = describeBulkApplyButton({
    capability,
    visibleCount: visibleOpportunities.length,
    busy: bulkApplying,
  });

  const unverifiedCount = visibleOpportunities.filter((opp) => isUnverifiedSource(opp.trustStatus)).length;
  const partiallyVerifiedCount = visibleOpportunities.filter((opp) =>
    isPartiallyVerified(opp.trustStatus),
  ).length;
  const verifiedCount = visibleOpportunities.length - unverifiedCount - partiallyVerifiedCount;

  if (loading) {
    return (
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <CardTitle id="opportunities-title">Find Jobs</CardTitle>
          {refreshButton}
        </CardHeader>
        <CardContent aria-labelledby="opportunities-title">
          <p className="text-sm text-ios-text-secondary animate-pulse">Loading opportunities…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <CardTitle id="opportunities-title">Find Jobs</CardTitle>
        {refreshButton}
      </CardHeader>
      <CardContent aria-labelledby="opportunities-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg mb-4">
            {error}{" "}
            <button
              type="button"
              onClick={() => setReloadToken((value) => value + 1)}
              className="font-medium text-ios-blue hover:underline"
            >
              Retry
            </button>
          </p>
        )}

        {/* Shown separately from the list error because the two have different
            consequences: the list failed to load, or the preferences that seed
            the filters did — and in the second case the list is still shown,
            unfiltered, which the candidate needs to know before trusting it. */}
        {preferencesError && (
          <p role="alert" className="text-sm text-status-blocked-fg mb-4">
            {preferencesError} Your filters started empty.
          </p>
        )}

        {refreshNotice && (
          <p
            role={refreshNotice.tone === "error" ? "alert" : "status"}
            aria-live="polite"
            className={`mb-4 rounded px-3 py-2 text-sm ${
              refreshNotice.tone === "error"
                ? "bg-red-50 border border-red-200 text-status-blocked-fg"
                : "bg-ios-separator/50 text-ios-text-secondary"
            }`}
          >
            {refreshNotice.text}
          </p>
        )}

        {/* Filter bar: below the header, above the results. The 10 declared
            filters and the 6 sorts live in OpportunityFilterBar, which is
            controlled and fetches nothing of its own; the primary action stays
            right-aligned on the same line. */}
        <div className="mb-4 flex flex-wrap items-start gap-2">
          <OpportunityFilterBar
            filters={filters ?? EMPTY_FILTERS}
            onChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            preferences={preferences}
          />

          {/* The count describes the LOADED LIST; the button describes the
              ACTION. Keeping them apart is what stops the label reading as a
              promise about how many applications will be sent — source
              capability never guaranteed that, and each job still has to pass
              its own gates. */}
          <span className="ml-auto self-center text-xs text-ios-text-secondary">
            {describeLoadedCount(visibleOpportunities.length)}
          </span>

          <Button
            size="sm"
            onClick={() => void handleBulkApply()}
            disabled={bulkApplyButton.disabled}
            aria-busy={bulkApplying}
            aria-describedby={bulkApplyButton.notice ? "bulk-apply-notice" : undefined}
          >
            {bulkApplyButton.label}
          </Button>
        </div>

        {/* The reason the action is unavailable, stated where the action is.
            role=status (not alert) for a capability limitation: it is a standing
            condition rather than something that just went wrong. The failed-read
            case is the one that needs interrupting, and it carries its own retry. */}
        {bulkApplyButton.notice && (
          <p
            id="bulk-apply-notice"
            role={capability.kind === "error" ? "alert" : "status"}
            className="mb-4 rounded border border-ios-separator bg-ios-bg px-3 py-2 text-xs text-ios-text-secondary"
          >
            {bulkApplyButton.notice}{" "}
            {capability.kind === "error" && (
              <button
                type="button"
                onClick={() => void loadCapability()}
                className="font-medium text-ios-blue hover:underline"
              >
                Retry
              </button>
            )}
          </p>
        )}

        {opportunities?.length === 0 && activeFilterCount === 0 && (
          <p className="text-sm text-ios-text-secondary">
            No opportunities yet. Use “Fetch latest jobs” to pull the newest listings.
          </p>
        )}

        {/* Distinct from the state above on purpose: "there are none" and
            "your filters match none of them" are different facts, and the
            second one must not read as an empty dataset. Since Task I this is
            the SERVER reporting no matches — the filter is a clause in SQL, not
            a pass over rows that happen to be loaded. */}
        {opportunities?.length === 0 && activeFilterCount > 0 && (
          <p className="text-sm text-ios-text-secondary">No opportunities match these filters.</p>
        )}

        {/* The role filter can empty a non-empty page. That is a different fact
            from "no jobs" and from "your filters match none", and it is the one
            the candidate can act on by editing their target roles. */}
        {(opportunities?.length ?? 0) > 0 && visibleOpportunities.length === 0 && (searchPreferences?.targetRoles.length ?? 0) > 0 && (
          <p className="text-sm text-ios-text-secondary">
            No jobs match your target roles.{" "}
            <Link href="/target-roles" className="text-ios-blue hover:underline">
              Update your target roles
            </Link>{" "}
            to widen the feed.
          </p>
        )}

        {hiddenByPreferences.length > 0 && (
          <p role="status" className="text-xs text-ios-text-secondary mb-3">
            Some loaded jobs were set aside by your search preferences: {hiddenByPreferences.join("; ")}.
          </p>
        )}

        {ranking != null && ranking.state !== "current" && ranking.state !== "no_target_roles" && (
          <p
            role="status"
            className="mb-3 rounded border border-ios-separator bg-ios-bg px-3 py-2 text-xs text-ios-text-secondary"
          >
            {feedRefresh.kind === "running" || feedRefresh.kind === "stalled"
              ? feedRefresh.text
              : ranking.state === "unavailable"
                ? "Preference ranking is unavailable right now — showing priority order."
                : "Preference ranking is still updating — showing priority order until your roles, preferences and posting evidence are current."}
            {feedRefresh.kind === "failed" && <> {feedRefresh.text}</>}{" "}
            {/* Retry invokes the REAL refresh path, not a reload of the same stale view. */}
            <button
              type="button"
              onClick={() => startRankingRefresh(true)}
              className="font-medium text-ios-blue hover:underline"
            >
              Retry
            </button>
          </p>
        )}

        {ranking != null && ranking.state === "no_target_roles" && (
          <p
            role="status"
            className="mb-3 rounded border border-ios-separator bg-ios-bg px-3 py-2 text-xs text-ios-text-secondary"
          >
            Choose your target roles to rank these jobs by your preferences.{" "}
            <Link href="/target-roles" className="text-ios-blue hover:underline">
              Choose roles
            </Link>
          </p>
        )}

        {visibleOpportunities.length > 0 && (
          <p className="text-xs text-ios-text-secondary mb-3">
            <>
              Sorted by {SORT_FIELDS_BY_ID[sort].label}
              {rankingCurrent ? " · ranked by your preferences" : ""}
            </>
            {/* Three buckets, because they are three different claims. The old
                line reported VERIFIED_INCOMPLETE as "verified", which is the
                same overstatement the badge made. */}
            {partiallyVerifiedCount > 0 && (
              <> · {verifiedCount} verified, {partiallyVerifiedCount} partly verified</>
            )}
            {partiallyVerifiedCount === 0 && unverifiedCount > 0 && (
              <> · {verifiedCount} verified</>
            )}
            {unverifiedCount > 0 && <> · {unverifiedCount} unverified</>}
            {/* The old "showing N of M loaded" line is gone with the client-side
                filter it described. The one thing that now narrows the loaded
                rows is the target-role filter below the header, and the count to
                its left is the number that survived it. */}
            {querying && <> · updating…</>}
          </p>
        )}

        {/* ONE explanation for the whole list, instead of the same paragraph on
            every card. Each card's trust badge is the indicator; this is where the
            candidate reads what it means. */}
        {(unverifiedCount > 0 || partiallyVerifiedCount > 0) && <TrustNoticeBanner />}

        <ul className="space-y-4" role="list" aria-label="Job opportunities">
          {visibleOpportunities.map((opp) => {
            const unverified = isUnverifiedSource(opp.trustStatus);
            const partiallyVerified = isPartiallyVerified(opp.trustStatus);
            // The full sentences live in the page-level banner and on the detail
            // page; the card badge is just the indicator. The tooltip repeats the
            // short version for anyone who hovers before reading the banner.
            const trustTitle = unverified
              ? "Unverified source \u2014 we cannot confirm this listing against the employer\u2019s own site. See the note above the list."
              : partiallyVerified
                ? "Partly verified \u2014 the listing is real, but some details are unconfirmed. See the note above the list."
                : undefined;

            return (
              <li
                key={opp.id}
                className={`border rounded-lg p-4 ${
                  unverified ? "border-status-under-review/40 bg-status-under-review/8" : "border-ios-separator"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1 min-w-0">
                    {/* THE INTERNAL DETAIL ROUTE. The title used to be an
                        outbound link straight to the job board; the full listing
                        is now read inside JobBeacon, and the outbound link lives
                        on that page so the candidate can decide after reading. */}
                    <Link
                      href={"/jobs/" + opp.id}
                      className="font-medium text-ios-blue hover:underline truncate block"
                    >
                      {opp.title}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ios-text-secondary">
                      {opp.companyName && (
                        <span className="font-medium text-black">{opp.companyName}</span>
                      )}
                      {opp.companyDomain && (
                        <span className="text-ios-text-secondary">· {opp.companyDomain}</span>
                      )}
                      <span>· {opp.location}</span>
                      {workplaceLabel(opp.remoteType) && (
                        <span className="px-2 py-0.5 bg-ios-separator rounded text-xs">
                          {workplaceLabel(opp.remoteType)}
                        </span>
                      )}
                      {/* Source attribution. Not decoration: some sources grant
                          API access only on condition of being named as the
                          source alongside a link back to their own URL (Remotive's
                          terms say so explicitly), and the job detail page links
                          back to the source's page. A listing whose origin is
                          invisible is also just less useful — "who is telling me
                          about this job" is a fair question to answer in place. */}
                      <span className="text-xs text-ios-text-secondary">
                        · via {formatSourceName(opp.sourceCode)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {newVacancyIds.includes(opp.id) && (
                        <Badge className="bg-ios-blue/10 px-1.5 py-0 text-[10px] font-semibold text-ios-blue">
                          New
                        </Badge>
                      )}
                      <StatusBadge status={trustStatusToBadge(opp.trustStatus)} title={trustTitle} />
                      <span className="text-xs text-ios-text-secondary">
                        {formatSalary(opp.salary)}
                      </span>
                      <span className="text-xs text-ios-text-secondary">
                        Discovered {formatDistanceToNow(new Date(opp.discoveredAt), { addSuffix: true })}
                      </span>
                      <StatusBadge status={autoApplyStatusBadge(opp.autoApplyStatus)} className="text-xs" />
                    </div>

                    <FitSection fit={opp.fitAnalysis} />
                  </div>

                  <div className="flex shrink-0 flex-col items-stretch gap-2">
                    {/* THE EXTERNAL LINK MOVED TO THE DETAIL PAGE. It used to sit here as a
                        second outbound anchor beside the title; the labelled
                        outbound link ("Open original job posting" /
                        "Apply on employer site") is rendered on /jobs/:id now. */}

                    {/* Offered only where the server will accept it. `unverified`
                        is isUnverifiedSource(opp.trustStatus) — the exact inverse
                        of the endpoint's VACANCY_TRUST_ELIGIBLE_STATUSES gate, so
                        the two cannot drift apart. An UNDER_REVIEW row stays
                        visible here (the view surfaces it deliberately) but gets
                        no generate action, rather than a button whose only
                        outcome is a refusal. */}
                    {!unverified && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setPrepVacancy(opp)}
                      >
                        Prepare for interview
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="mt-4 w-full rounded-lg border border-ios-separator py-2 text-sm text-ios-blue hover:bg-ios-separator/30 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </CardContent>

      {/* Rendered inside the Card, but Radix portals the content to body, so it
          is not affected by the card's layout or overflow. */}
      <InterviewPrepDialog
        vacancyId={prepVacancy?.id ?? null}
        vacancyTitle={prepVacancy?.title ?? ""}
        onClose={() => setPrepVacancy(null)}
      />
    </Card>
  );
}
