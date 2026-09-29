import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge, type StatusBadgeStatus } from "../components/ui/status-badge";
import {
  listOpportunities,
  listOpportunitiesByIds,
  type OpportunityFitAnalysis,
  type OpportunitySummary,
  type OpportunityTrustStatus,
} from "../lib/opportunities";
import { describeBulkApplyResult, submitBulkApply } from "../lib/bulkApply";
import {
  describeBulkApplyButton,
  describeLoadedCount,
  fetchQueueCapability,
  type QueueCapabilityState,
} from "../lib/queueCapability";
import { describeDiscoveryResult, discoverLiveJobs } from "../lib/ingestion";
import { matchesWorkplaceFilter, workplaceLabel, type WorkplaceValue } from "../lib/opportunityFilters";
import { DEFAULT_SORT, SORT_FIELDS_BY_ID, type SortId } from "../../../shared/opportunityQuery";
import {
  EMPTY_FILTERS,
  countActiveFilters,
  deriveFiltersFromPreferences,
  type OpportunityFilters,
} from "../lib/opportunityQuery";
import { loadCandidatePreferences, type CandidatePreferences } from "../lib/candidatePreferences";
import { OpportunityFilterBar } from "./OpportunityFilterBar";
import { InterviewPrepDialog } from "../components/InterviewPrepDialog";
import { showToast } from "../components/ui/use-toast";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { safeVacancyHref } from "./shared";
import { formatSalary } from "../lib/opportunities";
import { formatDistanceToNow } from "date-fns";

/**
 * The work-mode filter stores the column vocabulary (remote / hybrid / on_site);
 * the client-side predicate's options are the UI's hyphenated ones. Mapped in
 * one place so the two vocabularies cannot drift apart unnoticed.
 */
const WORKPLACE_VALUE_BY_WORK_MODE: Record<string, WorkplaceValue> = {
  remote: "remote",
  hybrid: "hybrid",
  on_site: "on-site",
};

function workplaceValuesFor(workModes: readonly string[]): WorkplaceValue[] {
  const values: WorkplaceValue[] = [];

  for (const mode of workModes) {
    const value = WORKPLACE_VALUE_BY_WORK_MODE[mode];

    if (value !== undefined) {
      values.push(value);
    }
  }

  return values;
}

const MAX_MISSING_SKILLS_SHOWN = 5;
const MAX_TOP_REASONS_SHOWN = 3;

interface RefreshNotice {
  tone: "info" | "error";
  text: string;
}

function priorityBadge(fit: OpportunityFitAnalysis): { label: string; className: string } {
  if (fit.eligibilityCapped) {
    return { label: "Not eligible", className: "bg-red-100 text-red-800" };
  }
  const score = fit.priority.score;
  if (score === null) {
    return { label: "Priority —", className: "bg-ios-separator text-ios-text-secondary" };
  }
  if (score >= 70) {
    return { label: `Priority ${score}`, className: "bg-green-100 text-green-800" };
  }
  if (score >= 40) {
    return { label: `Priority ${score}`, className: "bg-amber-100 text-amber-800" };
  }
  return { label: `Priority ${score}`, className: "bg-ios-separator text-ios-text-secondary" };
}

function FitSection({ fit }: { fit: OpportunityFitAnalysis | null }) {
  if (fit === null) {
    return <p className="mt-2 text-xs text-ios-text-secondary italic">Fit analysis pending</p>;
  }

  const badge = priorityBadge(fit);
  const shownSkills = fit.missingEvidence.slice(0, MAX_MISSING_SKILLS_SHOWN);
  const extraSkills = fit.missingEvidence.length - shownSkills.length;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.className}`}>{badge.label}</span>
        <span className="text-xs text-ios-text-secondary">
          Technical fit {fit.technicalFitScore ?? "—"}
          {fit.technicalFitScore === null && !fit.jdTextAvailable ? " (no job description text)" : ""}
        </span>
        <span className="text-xs text-ios-text-secondary">
          Eligibility {fit.practicalEligibilityScore ?? "—"}
        </span>
        {fit.eligibilityCapped && fit.priority.uncappedScore !== null && (
          <span className="text-xs text-ios-text-secondary">
            (would rank {fit.priority.uncappedScore} if eligible)
          </span>
        )}
      </div>

      {fit.hardBlockers.length > 0 && (
        <div role="alert" className="rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">
          <span className="font-medium">Not eligible.</span>{" "}
          {fit.hardBlockers.map((b) => b.detail).join(" ")}
        </div>
      )}

      {shownSkills.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ios-text-secondary">Missing:</span>
          {shownSkills.map((skill, i) => (
            <span key={`${skill}-${i}`} className="px-2 py-0.5 bg-ios-separator rounded text-xs">
              {skill}
            </span>
          ))}
          {extraSkills > 0 && (
            <span className="text-xs text-ios-text-secondary">+{extraSkills} more</span>
          )}
        </div>
      )}

      {fit.topReasons.length > 0 && (
        <ul className="list-disc list-inside text-xs text-ios-text-secondary space-y-0.5">
          {fit.topReasons.slice(0, MAX_TOP_REASONS_SHOWN).map((reason, i) => (
            <li key={`${reason}-${i}`}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * An opportunity whose source could not be established as the employer's own
 * system of record (trust_status UNDER_REVIEW — every aggregator-tier source
 * lands here, see 20260917120000). Treated as "show, but never silently":
 * the card is rendered with a warning badge and an explicit explanation
 * rather than being hidden, because a relevant job the candidate cannot see
 * is its own failure mode.
 */
/**
 * The source's name as a candidate should read it.
 *
 * A lookup rather than a title-case helper, because source_code is an internal
 * identifier: "usajobs" title-cased is "Usajobs", and this repository's own
 * product naming for that source is USAJOBS. Unknown sources fall back to the
 * raw code, which is at least true.
 */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  remotive: "Remotive",
  jooble: "Jooble",
  usajobs: "USAJOBS",
  adzuna: "Adzuna",
  greenhouse: "Greenhouse",
  lever: "Lever",
  local_fixture: "the local fixture",
};

function formatSourceName(sourceCode: string): string {
  return SOURCE_DISPLAY_NAMES[sourceCode] ?? sourceCode;
}

/**
 * UNDER_REVIEW — the source could not be established as the employer's own
 * system of record. Distinct from VERIFIED_INCOMPLETE, which is "we have the
 * listing but not every detail": the two get different badges and different
 * explanatory copy below the card, because they are different claims.
 */
function isUnverifiedSource(status: OpportunityTrustStatus): boolean {
  return status !== "VERIFIED" && status !== "VERIFIED_INCOMPLETE";
}

/** VERIFIED_INCOMPLETE — a real listing with unconfirmed non-critical details. */
function isPartiallyVerified(status: OpportunityTrustStatus): boolean {
  return status === "VERIFIED_INCOMPLETE";
}

function trustStatusToBadge(status: OpportunityTrustStatus): StatusBadgeStatus {
  switch (status) {
    case "VERIFIED":
      return "verified";
    case "VERIFIED_INCOMPLETE":
      // Task Y: no longer shares the green "Verified" badge. These listings are
      // real and linkable but their non-critical details were never confirmed,
      // and showing them as fully verified told the candidate otherwise.
      return "partially_verified";
    case "UNDER_REVIEW":
      // "Unverified source", not the generic "Under review": this label is
      // candidate-facing copy about the listing's provenance, and "under
      // review" reads as an internal moderation state.
      return "unverified_source";
    case "FLAGGED":
      return "under_review";
    case "BLOCKED":
    case "EXPIRED_REMOVED":
      return "blocked";
    case "ACTION_REQUIRED":
      return "action_required";
  }
}

function autoApplyStatusBadge(status: OpportunitySummary["autoApplyStatus"]): StatusBadgeStatus {
  switch (status) {
    case "not_started":
      return "apply_not_started";
    case "queued":
      return "apply_queued";
    case "in_progress":
      return "apply_in_progress";
    case "action_required":
      return "apply_action_required";
    case "completed":
      return "apply_completed";
    case "failed":
      return "apply_failed";
  }
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
   * The vacancies the most recent fetch created, fetched BY ID.
   *
   * ON HOLD FOR SCORED JOBS. Since Task A2 the backend scores new vacancies
   * before responding, and a scored job ranks on its own merit — hoisting it
   * would override the very ordering this was meant to fix. So this holds only
   * the new vacancies that did NOT get a priority (the per-press bound was
   * reached, or scoring failed). Those carry a NULL priority_score and sort
   * below every scored row, several pages down, so without this they would be
   * invisible. When everything was scored, this stays empty and the list is
   * purely organic.
   */
  const [newlyDiscovered, setNewlyDiscovered] = useState<OpportunitySummary[]>([]);

  /**
   * Every vacancy the last fetch created, whether or not it was scored.
   *
   * Separate from newlyDiscovered because the two answer different questions:
   * newlyDiscovered decides ORDER (an unscored row would otherwise be
   * invisible), this decides LABELLING. A scored job ranks on merit and must
   * not be moved — but the candidate still has no way to tell which three of
   * eighty rows just arrived without a marker, and the toast alone sends them
   * hunting for it.
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
   * The ONE place the list is read, and the reason filters and sort are
   * dependencies rather than state the callers have to remember to re-apply.
   *
   * Task I made the filtering and the ordering SERVER-SIDE, so a page now holds
   * up to a full page of matches rather than a filtered subset of whatever rows
   * happened to be loaded. That is what removes the old "showing 4 of 25 loaded"
   * caveat — and it is also why nothing narrows the fetched rows again below.
   */
  useEffect(() => {
    if (filters === null) return;

    let cancelled = false;
    setQuerying(true);

    listOpportunities(getSupabaseBrowserClient(), { filters, preferences, sort }).then((result) => {
      if (cancelled) return;

      setQuerying(false);
      setLoading(false);

      if (result.kind === "success") {
        setOpportunities(result.opportunities);
        setHasMore(result.hasMore);
        setError(null);
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filters, preferences, sort]);

  // Phase 2.3c: paging is offset-based off the current row count. The view
  // orders by the stored priority_score, so an urgency refresh can shuffle a
  // row across a page boundary; appending rather than replacing keeps any
  // such row visible instead of dropping it.
  async function loadMore() {
    setLoadingMore(true);
    const result = await listOpportunities(getSupabaseBrowserClient(), {
      offset: opportunities?.length ?? 0,
      // The same filters, exclusions and sort as the first page. A page fetched
      // under different clauses would be a second, silently different result set
      // appended to the first.
      filters: filters ?? EMPTY_FILTERS,
      preferences,
      sort,
    });
    setLoadingMore(false);

    if (result.kind === "success") {
      setOpportunities((prev) => [...(prev ?? []), ...result.opportunities]);
      setHasMore(result.hasMore);
    } else {
      setError(result.message);
    }
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
    setNewlyDiscovered([]);
    setNewVacancyIds([]);

    try {
      const outcome = await discoverLiveJobs();

      if (outcome.kind === "error") {
        setRefreshNotice({ tone: "error", text: outcome.message });
        showToast({ title: outcome.message, tone: "error" });
        return;
      }

      const client = getSupabaseBrowserClient();

      // Only the ones that came back WITHOUT a priority score need hoisting.
      // A scored vacancy is already ranked where it belongs.
      const unscoredIds = outcome.result.newVacancyIds.slice(
        // The backend scores in order, so the first fitAnalyzed ids are the ones
        // that have a score. Slicing rather than re-deriving from the rows keeps
        // this correct even when a fit analysis ran but produced no priority.
        Math.max(outcome.result.fitAnalyzed, 0),
      );

      const [reloaded, discovered] = await Promise.all([
        // The SAME filters, exclusions and sort the list is currently showing.
        // Re-reading page 1 unfiltered here would silently replace a filtered list
        // with an unfiltered one the moment somebody pressed "Fetch latest jobs".
        listOpportunities(client, { filters: filters ?? EMPTY_FILTERS, preferences, sort }),
        listOpportunitiesByIds(client, unscoredIds),
      ]);

      setNewVacancyIds(outcome.result.newVacancyIds);

      if (discovered.kind === "success") {
        setNewlyDiscovered(narrowToWorkMode(discovered.opportunities));
      }

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
   * NO CLIENT-SIDE WORKPLACE FILTERING ANY MORE. The old bar filtered the rows
   * it had already loaded through matchesWorkplaceFilter; work mode is now a
   * server-side clause on remote_type, so running that predicate over the
   * fetched page as well would narrow the same rows twice — and would quietly
   * override the server wherever the two vocabularies disagreed. The loaded rows
   * are therefore shown exactly as returned.
   *
   * THE ONE REMAINING USE OF THE LOCAL PREDICATE. The freshly discovered
   * vacancies are fetched BY ID, not through the filtered query, so they never
   * passed the work-mode clause. Applying the existing predicate to that one
   * bucket is not a double application — it is the only thing standing between a
   * Remote-only filter (often seeded from the candidate's own preference) and an
   * on-site listing hoisted to the top of the results. Every OTHER active filter
   * is left to the server: re-implementing the query builder's clauses here
   * would be a second copy of it that could only drift.
   */
  const selectedWorkplaces = useMemo(
    () => workplaceValuesFor(filters?.workModes ?? []),
    [filters],
  );

  function narrowToWorkMode(rows: readonly OpportunitySummary[]): OpportunitySummary[] {
    return rows.filter((opportunity) => matchesWorkplaceFilter(opportunity, selectedWorkplaces));
  }

  /**
   * Newly fetched jobs first, everything else untouched.
   *
   * They have no fit_analysis yet, so their priority_score is null and they
   * sort below every scored row — with ~80 loaded that is several pages down,
   * which is indistinguishable from "the fetch did nothing". Hoisting them is
   * a deliberately local, temporary reorder: it lasts until the next fetch,
   * and the sort line below says it is happening rather than quietly
   * contradicting its own "sorted by" label.
   */
  const visibleOpportunities = useMemo(() => {
    if (newlyDiscovered.length === 0) {
      return opportunities ?? [];
    }

    // The freshly fetched rows go on top; anything that is ALSO in the loaded
    // page is dropped from its old position rather than rendered twice.
    const freshIds = new Set(newlyDiscovered.map((opportunity) => opportunity.id));

    return [...newlyDiscovered, ...(opportunities ?? []).filter((opportunity) => !freshIds.has(opportunity.id))];
  }, [opportunities, newlyDiscovered]);

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
          <CardTitle id="opportunities-title">Opportunities</CardTitle>
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
        <CardTitle id="opportunities-title">Opportunities</CardTitle>
        {refreshButton}
      </CardHeader>
      <CardContent aria-labelledby="opportunities-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg mb-4">
            {error}
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

        {visibleOpportunities.length > 0 && (
          <p className="text-xs text-ios-text-secondary mb-3">
            {newlyDiscovered.length > 0 ? (
              <>
                Sorted by {SORT_FIELDS_BY_ID[sort].label} · {newlyDiscovered.length} newly fetched shown
                first
              </>
            ) : (
              <>Sorted by {SORT_FIELDS_BY_ID[sort].label}</>
            )}
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
                filter it described: filtering now happens in SQL, so the loaded
                rows ARE the matches and the two numbers were always equal. */}
            {querying && <> · updating…</>}
          </p>
        )}

        <ul className="space-y-4" role="list" aria-label="Job opportunities">
          {visibleOpportunities.map((opp) => {
            const unverified = isUnverifiedSource(opp.trustStatus);
                  const partiallyVerified = isPartiallyVerified(opp.trustStatus);

            return (
              <li
                key={opp.id}
                className={`border rounded-lg p-4 ${
                  unverified ? "border-status-under-review/40 bg-status-under-review/8" : "border-ios-separator"
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1 min-w-0">
                    <a
                      href={safeVacancyHref(opp.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-ios-blue hover:underline truncate block"
                    >
                      {opp.title}
                    </a>
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
                          terms say so explicitly), and the title above already
                          links to the source's page. A listing whose origin is
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
                      <StatusBadge status={trustStatusToBadge(opp.trustStatus)} />
                      <span className="text-xs text-ios-text-secondary">
                        {formatSalary(opp.salary)}
                      </span>
                      <span className="text-xs text-ios-text-secondary">
                        Discovered {formatDistanceToNow(new Date(opp.discoveredAt), { addSuffix: true })}
                      </span>
                      <StatusBadge status={autoApplyStatusBadge(opp.autoApplyStatus)} className="text-xs" />
                    </div>

                    {unverified && (
                      <p
                        role="note"
                        className="mt-3 rounded border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
                      >
                        <span className="font-semibold">We haven’t verified this employer or listing.</span>{" "}
                        It came from a third-party job board we can’t confirm against the employer’s own
                        site, so the details and the salary shown may be out of date. Confirm everything on
                        the source site before you apply or share any personal information.
                      </p>
                    )}

                    {/* A different claim from the one above, so it gets different
                        copy rather than sharing the "unverified employer"
                        wording: the listing itself is legitimate, it is the
                        supporting detail that is missing. */}
                    {partiallyVerified && (
                      <p
                        role="note"
                        className="mt-3 rounded border border-status-under-review/40 bg-status-under-review/8 px-3 py-2 text-xs text-status-under-review-fg"
                      >
                        <span className="font-semibold">Some details aren’t confirmed.</span>{" "}
                        This listing is real, but its source doesn’t publish the employer’s own website,
                        a location or a salary we can check, so those fields may be absent rather than
                        wrong. Open the original posting to confirm anything you’re relying on.
                      </p>
                    )}

                    <FitSection fit={opp.fitAnalysis} />
                  </div>

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
                      className="shrink-0"
                      onClick={() => setPrepVacancy(opp)}
                    >
                      Prepare for interview
                    </Button>
                  )}
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
