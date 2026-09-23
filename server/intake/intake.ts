import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDiscoveredVacancy } from "../ingestion/ingest.js";
import type { FetchImpl } from "../ingestion/types.js";
import { scoreVacancy } from "../trust/scoreVacancy.js";
import { getIntakeAdapter, listIntakeAdapters } from "./adapters/registry.js";
import type { IntakeAdapter } from "./adapters/types.js";

/**
 * Task W — on-demand job intake.
 *
 * WHAT THIS IS FOR. Every vacancy in this database before now came from either
 * a scheduled poll of a source configured in vacancy_sources, or a hand-written
 * seed migration. Neither is available to an agent: the first needs a
 * scheduler, the second is the treadmill this task exists to end. This module
 * is the third door — "go and get me real postings matching this, now" — and it
 * is what the discover_live_jobs MCP tool calls.
 *
 * IT REUSES THE EXISTING WRITE PATH RATHER THAN REIMPLEMENTING IT. Vacancies
 * are written by ingestDiscoveredVacancy (dedup by source+id, dedup by URL,
 * company upsert, fingerprint, version history) and scored by scoreVacancy —
 * the same two functions the ingestion worker calls. A second insert path here
 * would be a second definition of what "a vacancy" is, free to drift from the
 * one the rest of the system validates against.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, unlike the scheduled worker:
 *
 *   * No ingestion_jobs row. That table is a lease queue for a scheduler; an
 *     agent asking a question is not a queued job, and writing one would make
 *     an interactive call compete with the poller for claims.
 *   * No markUnseenVacanciesExpired. Expiry means "this target's sweep did not
 *     see it", which is only meaningful for a full sweep. A targeted search for
 *     "data engineer" that expired everything it did not match would empty the
 *     table on the first query.
 *
 * It DOES record a source_health_events row, because that table is where this
 * repository answers "did this source work, and when", and an intake run is
 * exactly as much of a source sync as a scheduled one.
 */

export class IntakePolicyError extends Error {
  constructor(sourceCode: string, detail: string) {
    super(`Intake is not permitted for source "${sourceCode}": ${detail}`);
    this.name = "IntakePolicyError";
  }
}

export interface RunIntakeInput {
  sourceCode: string;
  search?: string;
  /**
   * Candidate-derived search context, passed through to the adapter untouched.
   *
   * These are optional here and stay optional, because whether they are REQUIRED
   * is a property of the source rather than of intake in general: Remotive
   * ignores all three, Jooble documents keywords and location as required, and
   * Adzuna needs a country. A source that cannot use what it was given throws,
   * and the fan-out records that as a skip with its reason.
   */
  keywords?: string;
  location?: string;
  country?: string;
  limit?: number;
}

export interface IntakeVacancyOutcome {
  vacancyId: string;
  title: string;
  companyName: string;
  /** "created" | "updated" | "unchanged" | "merged_as_source_record" — from ingestDiscoveredVacancy. */
  outcome: string;
  /**
   * The status the trust scorer recorded for this vacancy — in
   * vacancy_trust_scores.status AND vacancies.trust_status, which are written
   * together in one pass. There is no second value to report, because intake
   * no longer writes one.
   */
  trustStatus?: string;
  scoreError?: string;
}

export interface RunIntakeResult {
  sourceCode: string;
  displayName: string;
  attribution: string;
  search: string | null;
  /** Listings the source returned, before the adapter filtered any. */
  received: number;
  /** Listings the adapter could not map (missing id, url, title or company). */
  skippedByAdapter: number;
  /** Listings written through ingestDiscoveredVacancy. */
  ingested: number;
  /**
   * How many ingested vacancies ended up in each trust status. A distribution
   * rather than one value: after Task Y the scorer decides per vacancy, so a
   * run can legitimately produce VERIFIED_INCOMPLETE for most rows and FLAGGED
   * for the ones it found something wrong with.
   */
  trustStatusCounts: Record<string, number>;
  outcomes: IntakeVacancyOutcome[];
  attributionNotice?: string;
  durationMs: number;
}

export interface RunIntakeDeps {
  fetchImpl?: FetchImpl;
  /** Injected in tests so scoring can be exercised without its own query graph. */
  score?: (client: SupabaseClient, vacancyId: string) => Promise<{ status: string }>;
  /**
   * Injected in tests: the per-source runner the fan-out calls. Defaults to
   * runIntake.
   *
   * Injectable because runIntake is a module-local reference, so vi.mock on this
   * module's exports cannot intercept the call the fan-out makes — and the
   * fan-out's own logic (isolation, aggregation, partial success) is precisely
   * what its tests need to exercise without standing up a whole Supabase graph.
   */
  runOne?: (client: SupabaseClient, input: RunIntakeInput, deps: RunIntakeDeps) => Promise<RunIntakeResult>;
}

/**
 * One source's contribution to a fan-out run.
 *
 * A failed source still gets an entry, with `status: "failed"` and the reason.
 * Reporting only the sources that worked would make "3 sources, 2 of them
 * misconfigured" indistinguishable from "1 source, working fine".
 */
export interface IntakeSourceSummary {
  sourceCode: string;
  displayName: string;
  /** The source's own attribution, which must travel with its data. */
  attribution: string;
  status: "ok" | "failed";
  /** Why this source was skipped. Present only when status is "failed". */
  error?: string;
  search: string | null;
  received: number;
  ingested: number;
  /** Vacancies that did not exist before this run. */
  created: number;
  /** Existing vacancies this run refreshed. */
  updated: number;
  skippedByAdapter: number;
  newVacancyIds: string[];
  trustStatusCounts: Record<string, number>;
  durationMs: number;
}

export interface RunIntakeFanOutResult {
  /** One entry per source attempted, in registry order. */
  sources: IntakeSourceSummary[];
  /** Aggregate listing counts across every source that ran. */
  received: number;
  ingested: number;
  created: number;
  updated: number;
  skippedByAdapter: number;
  /** Union of every source's new ids, so the client can mark all of them. */
  newVacancyIds: string[];
  trustStatusCounts: Record<string, number>;
  durationMs: number;
  /** How many sources were skipped, so a caller can report partial success. */
  failedSources: number;
}

export interface RunIntakeFanOutInput {
  /** Restrict to these sources. Omitted or empty means every registered source. */
  sourceCodes?: readonly string[];
  search?: string;
  /** Same candidate-derived context RunIntakeInput carries; sent to every source. */
  keywords?: string;
  location?: string;
  country?: string;
  limit?: number;
}

/**
 * Runs on-demand intake across several sources and aggregates the result.
 *
 * WHY THIS EXISTS: the candidate-facing "Fetch latest jobs" button used to
 * depend on the server picking a single source — it 400'd ("Unknown intake
 * source") whenever more than one adapter was registered and the client, which
 * sends no body, named none. The button worked only for as long as exactly one
 * source existed. Fanning out removes that fragility at the root: registering a
 * new adapter can no longer break the client contract.
 *
 * PARTIAL SUCCESS IS THE DESIGN, NOT A FALLBACK. A source with no
 * source_policies row, with its kill_switch on, or whose API is simply down must
 * not cost the candidate the sources that do work — that would be the same class
 * of total failure this change exists to remove. Each source is isolated, its
 * failure is recorded as a value, and the run continues. runIntake already
 * writes a source_health_events row for a fetch failure before rethrowing, so
 * the failure is durable as well as reported.
 *
 * SEQUENTIAL, DELIBERATELY. These are third-party APIs with hard quotas —
 * Jooble's free plan is a 500-request LIFETIME budget and every page and retry
 * spends one — so fanning out concurrently would multiply the burst rate against
 * every source simultaneously, for latency no candidate would notice on a
 * button they press occasionally.
 */
export async function runIntakeAcrossSources(
  client: SupabaseClient,
  input: RunIntakeFanOutInput = {},
  deps: RunIntakeDeps = {},
): Promise<RunIntakeFanOutResult> {
  const registered = listIntakeAdapters();

  const wanted =
    input.sourceCodes && input.sourceCodes.length > 0
      ? registered.filter((adapter) => input.sourceCodes!.includes(adapter.sourceCode))
      : registered;

  const startedAt = Date.now();
  const sources: IntakeSourceSummary[] = [];
  const runOne = deps.runOne ?? runIntake;

  for (const adapter of wanted) {
    const sourceStartedAt = Date.now();

    try {
      const result = await runOne(
        client,
        {
          sourceCode: adapter.sourceCode,
          search: input.search,
          limit: input.limit,
          // Every source receives the same context and each decides whether it
          // can use it. The fan-out deliberately has no per-source knowledge:
          // teaching it "jooble needs a location" would put one source's
          // requirements in the shared layer, which is the coupling the
          // registry exists to avoid.
          keywords: input.keywords,
          location: input.location,
          country: input.country,
        },
        deps,
      );

      const created = result.outcomes.filter((outcome) => outcome.outcome === "created");
      const updated = result.outcomes.filter((outcome) => outcome.outcome === "updated");

      sources.push({
        sourceCode: result.sourceCode,
        displayName: result.displayName,
        attribution: result.attribution,
        status: "ok",
        search: result.search,
        received: result.received,
        ingested: result.ingested,
        created: created.length,
        updated: updated.length,
        skippedByAdapter: result.skippedByAdapter,
        newVacancyIds: created.map((outcome) => outcome.vacancyId),
        trustStatusCounts: result.trustStatusCounts,
        durationMs: result.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Logged, not swallowed: a skipped source is invisible to the candidate
      // unless someone can see why. The response carries it too.
      console.error(`[intake] source "${adapter.sourceCode}" skipped: ${message}`);

      sources.push({
        sourceCode: adapter.sourceCode,
        displayName: adapter.displayName,
        attribution: adapter.attribution,
        status: "failed",
        error: message,
        search: null,
        received: 0,
        ingested: 0,
        created: 0,
        updated: 0,
        skippedByAdapter: 0,
        newVacancyIds: [],
        trustStatusCounts: {},
        durationMs: Date.now() - sourceStartedAt,
      });
    }
  }

  const trustStatusCounts: Record<string, number> = {};
  for (const source of sources) {
    for (const [status, count] of Object.entries(source.trustStatusCounts)) {
      trustStatusCounts[status] = (trustStatusCounts[status] ?? 0) + count;
    }
  }

  const sum = (pick: (source: IntakeSourceSummary) => number) =>
    sources.reduce((total, source) => total + pick(source), 0);

  return {
    sources,
    received: sum((s) => s.received),
    ingested: sum((s) => s.ingested),
    created: sum((s) => s.created),
    updated: sum((s) => s.updated),
    skippedByAdapter: sum((s) => s.skippedByAdapter),
    newVacancyIds: sources.flatMap((source) => source.newVacancyIds),
    trustStatusCounts,
    durationMs: Date.now() - startedAt,
    failedSources: sources.filter((source) => source.status === "failed").length,
  };
}

/**
 * Resolves the source's policy row and refuses to fetch when the source is
 * switched off. Same two conditions the scheduled worker checks
 * (discovery_allowed, kill_switch) — an agent-triggered path must not be a way
 * around a source that has been disabled for everyone else.
 */
async function requireDiscoverableSource(client: SupabaseClient, sourceCode: string): Promise<void> {
  const { data, error } = await client
    .from("source_policies")
    .select("discovery_allowed, kill_switch")
    .eq("source_code", sourceCode)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new IntakePolicyError(sourceCode, "no source_policies row exists for it");
  }

  const policy = data as { discovery_allowed: boolean; kill_switch: boolean };

  if (policy.kill_switch) {
    throw new IntakePolicyError(sourceCode, "its kill_switch is on");
  }

  if (!policy.discovery_allowed) {
    throw new IntakePolicyError(sourceCode, "discovery_allowed is false");
  }
}

/**
 * Resolves the vacancy_sources row ingestDiscoveredVacancy needs for its
 * foreign key. A source can be intake-only and still need one row; the row's
 * enabled flag governs POLLING, not intake, which is why this does not check it.
 */
async function requireVacancySourceId(client: SupabaseClient, sourceCode: string): Promise<string> {
  const { data, error } = await client
    .from("vacancy_sources")
    .select("id")
    .eq("source_code", sourceCode)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new IntakePolicyError(
      sourceCode,
      "no vacancy_sources row exists for it, and vacancies.vacancy_source_id is a required foreign key",
    );
  }

  return (data as { id: string }).id;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function runIntake(
  client: SupabaseClient,
  input: RunIntakeInput,
  deps: RunIntakeDeps = {},
): Promise<RunIntakeResult> {
  const adapter: IntakeAdapter = getIntakeAdapter(input.sourceCode);
  const startedAt = Date.now();

  // Clamped rather than rejected: an agent asking for 500 gets 100 and a
  // truthful count of what it got, which is more useful than an error and
  // cannot be used to hammer a third-party API.
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const search = input.search?.trim() ? input.search.trim() : undefined;

  await requireDiscoverableSource(client, adapter.sourceCode);
  const vacancySourceId = await requireVacancySourceId(client, adapter.sourceCode);

  let fetched;
  try {
    fetched = await adapter.fetchLiveJobs(
      {
        search,
        limit,
        // Normalised to undefined rather than passed as a blank string, matching
        // how `search` above is handled: an empty string would be a value the
        // adapter has to re-test, and "absent" is the honest state.
        keywords: input.keywords?.trim() ? input.keywords.trim() : undefined,
        location: input.location?.trim() ? input.location.trim() : undefined,
        country: input.country?.trim() ? input.country.trim() : undefined,
      },
      deps.fetchImpl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await client.from("source_health_events").insert({
      source_code: adapter.sourceCode,
      vacancy_source_id: vacancySourceId,
      status: "error",
      error_message: message,
      duration_ms: Date.now() - startedAt,
    });

    throw error;
  }

  const score = deps.score ?? ((c: SupabaseClient, id: string) => scoreVacancy(c, id));
  const outcomes: IntakeVacancyOutcome[] = [];

  for (const item of fetched.vacancies) {
    const result = await ingestDiscoveredVacancy(client, adapter.sourceCode, vacancySourceId, item);

    const outcome: IntakeVacancyOutcome = {
      vacancyId: result.vacancyId,
      title: item.rawTitle,
      companyName: item.companyName,
      outcome: result.outcome,
    };

    // The scorer is the ONLY writer of a vacancy's trust status. It records one
    // status in vacancy_trust_scores and vacancies together, including
    // VERIFIED_INCOMPLETE for sources that declare partial verification (see
    // resolveStatus in trust/scoreVacancy.ts). Intake previously overwrote
    // vacancies.trust_status afterwards, which is precisely what left the two
    // tables disagreeing.
    //
    // Never fatal: the ingestion worker already treats scoring as best-effort
    // ("ingestion must remain available when trust scoring is slow"), and an
    // unscored vacancy is a normal state — it stays trust_status NULL, which is
    // neither eligible nor visible, and the next scoring pass picks it up.
    try {
      const scored = await score(client, result.vacancyId);
      outcome.trustStatus = scored.status;
    } catch (error) {
      outcome.scoreError = error instanceof Error ? error.message : String(error);
    }

    outcomes.push(outcome);
  }

  await client.from("source_health_events").insert({
    source_code: adapter.sourceCode,
    vacancy_source_id: vacancySourceId,
    status: "success",
    vacancies_fetched: fetched.vacancies.length,
    duration_ms: Date.now() - startedAt,
  });

  const trustStatusCounts: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = outcome.trustStatus ?? "unscored";
    trustStatusCounts[key] = (trustStatusCounts[key] ?? 0) + 1;
  }

  return {
    sourceCode: adapter.sourceCode,
    displayName: adapter.displayName,
    attribution: adapter.attribution,
    search: search ?? null,
    received: fetched.received,
    skippedByAdapter: fetched.skipped,
    ingested: outcomes.length,
    trustStatusCounts,
    outcomes,
    durationMs: Date.now() - startedAt,
  };
}
