import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTitleRelevantToRole } from "../../shared/roleTaxonomy.js";
import { evidenceFingerprint } from "../../shared/evidenceTokens.js";

/**
 * Materialises which of a candidate's SELECTED ROLES each BROWSEABLE vacancy
 * matches, using the AUTHORITATIVE shared matcher, and tracks whether that
 * materialisation is still VALID for the current vacancy corpus.
 *
 * WHY THIS IS THE ONLY CORRECT WAY. Qualifier ranking may count a preference only
 * for a role the vacancy actually matches, and that rule is
 * isTitleRelevantToRole — TypeScript. SQL cannot call it, so the matches are
 * computed here and persisted, and ordering in SQL becomes a plain join. Any
 * keyword approximation in SQL would be a second matcher, which is not approved.
 *
 * THE CORPUS IS THE BROWSEABLE SET, mirrored exactly from
 * public.candidate_opportunities: status = 'active' AND trust_status IN
 * ('VERIFIED', 'VERIFIED_INCOMPLETE', 'UNDER_REVIEW'). A vacancy that is not
 * browseable is not part of the materialised corpus.
 *
 * IT NEVER CONSENTS TO ANYTHING. This is manual matching: it needs no automation
 * consent, no paid plan and no parsed resume. It creates no attempt, submits
 * nothing and activates no task.
 *
 * SPARSE AND COVERAGE-SCOPED. Only matching pairs are written. An absent pair is
 * UNKNOWN until a scan with the same role inputs, matcher version and CORPUS
 * VERSION COMPLETES; the published generation is advanced only then, so a partial
 * or failed scan never destroys usable data.
 *
 * INPUT FRESHNESS is tracked independently of the positive matches, because a
 * previously NON-matching vacancy that becomes relevant has no match row to
 * fingerprint:
 *   * every match row records the EXACT raw_title passed to the matcher
 *     (input_title); legacy rows keep NULL and stay UNKNOWN;
 *   * a transactional, monotonic corpus version (bumped by a database trigger on
 *     the relevant vacancy mutations) is recorded at generation start and
 *     validated again when publishing. A keyset cursor, updated_at or a UUID
 *     ordering is NOT treated as freshness evidence.
 *
 * STAGED GENERATIONS. A replacement scan writes a new generation alongside the
 * old one, so work in progress never destroys data that is already usable. The
 * readable generation is the one named by published_generation, advanced only
 * when a scan completes AND the corpus version it started at is still current.
 */

/** Bump when the matching rule changes; invalidates completed coverage. */
export const ROLE_MATCHER_VERSION = "role-taxonomy-v1";

/**
 * The browseable corpus predicate, mirrored from public.candidate_opportunities
 * (20260917130000_candidate_opportunities_include_under_review.sql). One
 * declaration, used by the scan, so the query and the documented semantics cannot
 * drift.
 */
export const BROWSEABLE_VACANCY_STATUS = "active";
export const BROWSEABLE_TRUST_STATUSES = ["VERIFIED", "VERIFIED_INCOMPLETE", "UNDER_REVIEW"] as const;

export const DEFAULT_MATCH_BATCH_SIZE = 200;
export const DEFAULT_MATCH_MAX_BATCHES = 5;

/** The database surface this module needs: table reads/writes and the two RPCs. */
export type RoleMatchClient = Pick<SupabaseClient, "from" | "rpc">;

export interface SelectedRoleInput {
  roleName: string;
}

/** Fingerprint of the candidate's selected-role inputs, so a role change invalidates coverage. */
export function roleInputFingerprint(roles: readonly SelectedRoleInput[]): string {
  const canonical = [...roles]
    .map((role) => role.roleName)
    .sort()
    .join("\u0002");

  return evidenceFingerprint({ title: canonical, description: null });
}

export interface MaterializeOptions {
  dryRun?: boolean;
  batchSize?: number;
  maxBatches?: number;
}

export type MaterializeStatus = "complete" | "running" | "failed" | "stale";

export interface MaterializeResult {
  candidateId: string;
  dryRun: boolean;
  roles: string[];
  /** The generation this run wrote into (or would have). */
  generation: string;
  /** The coverage verdict observed before this run touched anything. */
  coverageState: RoleMatchCoverageState;
  /** The current corpus version this run worked against. */
  corpusVersion: number;
  /** Whether the corpus traversal reached its end during this invocation. */
  corpusComplete: boolean;
  batches: number;
  scanned: number;
  matched: number;
  /** Set when the previous published coverage was invalidated by this run. */
  startedNewGeneration: boolean;
  status: MaterializeStatus;
  error?: string;
}

interface VacancyRow {
  id: string;
  raw_title: string | null;
}

interface CoverageRow {
  published_generation: string | null;
  running_generation: string | null;
  corpus_cursor: string | null;
  corpus_complete: boolean;
  role_input_fingerprint: string | null;
  matcher_version: string | null;
  running_corpus_version: number | null;
  published_corpus_version: number | null;
  status: string;
  scanned: number;
  matched: number;
}

/** The validity of a candidate's materialised coverage as of this read. */
export type RoleMatchCoverageState =
  | "none"
  | "current"
  | "stale"
  | "partial"
  | "failed"
  | "legacy-unknown";

/**
 * What a reader (the materialiser today, the feed later) may conclude about a
 * candidate's coverage. Every field is exposed because the materialiser must
 * resume from the exact state the verdict was computed from.
 */
export interface RoleMatchCoverage {
  candidateId: string;
  state: RoleMatchCoverageState;
  /** Human-readable reason for state; safe to log, contains no candidate data. */
  reason: string;
  currentCorpusVersion: number;
  publishedGeneration: string | null;
  publishedCorpusVersion: number | null;
  runningGeneration: string | null;
  runningCorpusVersion: number | null;
  corpusCursor: string | null;
  corpusComplete: boolean;
  roleInputFingerprint: string | null;
  matcherVersion: string | null;
  status: string;
  scanned: number;
  matched: number;
  /** True only when an incomplete scan may be continued in place. */
  resumable: boolean;
}

export interface LoadCoverageOptions {
  /** Skip re-reading selected roles when the caller already knows them. */
  roles?: readonly SelectedRoleInput[];
}

const COVERAGE_COLUMNS =
  "published_generation, running_generation, corpus_cursor, corpus_complete, role_input_fingerprint, matcher_version, running_corpus_version, published_corpus_version, status, scanned, matched";

/**
 * Supabase/PostgREST errors are PLAIN OBJECTS, not Error instances, so
 * String(error) would report "[object Object]" and lose the only actionable part
 * — which is precisely the part an operator needs from the CLI.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

function rolesFrom(data: unknown): string[] {
  return ((data ?? []) as Array<{ role_name: string }>).map((row) => row.role_name);
}

export async function readSelectedRoles(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
): Promise<SelectedRoleInput[]> {
  const { data, error } = await client
    .from("candidate_selected_roles")
    .select("role_name")
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  return rolesFrom(data).map((roleName) => ({ roleName }));
}

/**
 * The current corpus version. A failure here is an ERROR, never a default: a
 * loader that silently substituted a version would turn "cannot validate" into
 * "validated", which is the failure this whole mechanism exists to prevent.
 */
export async function readCurrentCorpusVersion(client: Pick<SupabaseClient, "rpc">): Promise<number> {
  const { data, error } = await client.rpc("current_role_match_corpus_version");

  if (error) {
    throw error;
  }

  const version = typeof data === "number" ? data : Number(data);

  if (!Number.isFinite(version)) {
    throw new Error("current_role_match_corpus_version returned no usable version");
  }

  return version;
}

/**
 * The candidate's coverage verdict as of NOW.
 *
 * NULL/ABSENT IS NOT "NO PREFERENCES". "none" means no coverage exists at all;
 * "legacy-unknown" means a generation was published before corpus versions were
 * recorded, so it cannot be proven current; "stale" means the inputs the
 * generation was derived from are no longer what they are now. Only "current"
 * may be presented as complete, current coverage.
 *
 * READ-TIME, NOT POINTER TRUST. The stored published version proves only what the
 * scan observed; the current version is re-read here and compared, so a corpus
 * change after publication is caught rather than trusted.
 */
export async function loadRoleMatchCoverage(
  client: RoleMatchClient,
  candidateId: string,
  options: LoadCoverageOptions = {},
): Promise<RoleMatchCoverage> {
  const roles = options.roles ?? (await readSelectedRoles(client, candidateId));
  const fingerprint = roleInputFingerprint(roles);
  const currentCorpusVersion = await readCurrentCorpusVersion(client);

  const { data, error } = await client
    .from("candidate_role_match_coverage")
    .select(COVERAGE_COLUMNS)
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data === null) {
    return {
      candidateId,
      state: "none",
      reason: "no coverage row exists for this candidate",
      currentCorpusVersion,
      publishedGeneration: null,
      publishedCorpusVersion: null,
      runningGeneration: null,
      runningCorpusVersion: null,
      corpusCursor: null,
      corpusComplete: false,
      roleInputFingerprint: null,
      matcherVersion: null,
      status: "idle",
      scanned: 0,
      matched: 0,
      resumable: false,
    };
  }

  const row = data as CoverageRow;
  const inputsMatch =
    row.role_input_fingerprint === fingerprint && row.matcher_version === ROLE_MATCHER_VERSION;

  const resumable =
    row.corpus_complete === false &&
    row.running_generation !== null &&
    inputsMatch &&
    row.running_corpus_version !== null &&
    row.running_corpus_version === currentCorpusVersion &&
    (row.status === "running" || row.status === "failed");

  let state: RoleMatchCoverageState;
  let reason: string;

  if (row.published_generation !== null) {
    // A published generation exists. Content equality decides validity, exactly
    // as loadPublishedQualifierGeneration() does for qualifier preferences.
    if (row.published_corpus_version === null) {
      state = "legacy-unknown";
      reason =
        "the published generation predates corpus-version recording, so it cannot be proven current";
    } else if (!inputsMatch) {
      state = "stale";
      reason = "the selected roles or matcher version changed since this generation was published";
    } else if (row.published_corpus_version !== currentCorpusVersion) {
      state = "stale";
      reason = "the browseable vacancy corpus changed after this generation was published";
    } else if (row.corpus_complete !== true) {
      state = "stale";
      reason = "a published generation is recorded without a completed corpus traversal";
    } else {
      state = "current";
      reason =
        "the published generation matches the current role inputs, matcher version and corpus version";
    }
  } else if (row.status === "failed") {
    state = "failed";
    reason = "the last scan failed; it is incomplete and published nothing";
  } else if (row.running_generation === null) {
    state = "none";
    reason = "coverage row exists but no scan has run";
  } else if (resumable) {
    state = "partial";
    reason = "an incomplete scan may be resumed: its inputs and corpus version are unchanged";
  } else {
    state = "stale";
    reason =
      "an incomplete scan cannot be resumed because its inputs or corpus version changed";
  }

  return {
    candidateId,
    state,
    reason,
    currentCorpusVersion,
    publishedGeneration: row.published_generation,
    publishedCorpusVersion: row.published_corpus_version,
    runningGeneration: row.running_generation,
    runningCorpusVersion: row.running_corpus_version,
    corpusCursor: row.corpus_cursor,
    corpusComplete: row.corpus_complete,
    roleInputFingerprint: row.role_input_fingerprint,
    matcherVersion: row.matcher_version,
    status: row.status,
    scanned: row.scanned,
    matched: row.matched,
    resumable,
  };
}

/** The running-coverage payload shared by the start/progress/failure writes. */
function runningCoverageRow(input: {
  candidateId: string;
  generation: string;
  cursor: string | null;
  fingerprint: string;
  corpusVersion: number;
  status: "running" | "failed";
  scanned: number;
  matched: number;
  lastError?: string;
}): Record<string, unknown> {
  return {
    candidate_id: input.candidateId,
    running_generation: input.generation,
    corpus_cursor: input.cursor,
    corpus_complete: false,
    role_input_fingerprint: input.fingerprint,
    matcher_version: ROLE_MATCHER_VERSION,
    running_corpus_version: input.corpusVersion,
    status: input.status,
    scanned: input.scanned,
    matched: input.matched,
    ...(input.lastError === undefined ? {} : { last_error: input.lastError }),
    updated_at: new Date().toISOString(),
  };
}

export async function materializeCandidateRoleMatches(
  client: RoleMatchClient,
  candidateId: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const dryRun = options.dryRun === true;
  const batchSize = options.batchSize ?? DEFAULT_MATCH_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MATCH_MAX_BATCHES;
  const now = new Date().toISOString();

  const roleInputs = await readSelectedRoles(client, candidateId);
  const roles = roleInputs.map((role) => role.roleName);
  const fingerprint = roleInputFingerprint(roleInputs);

  // THE COVERAGE-LOADING PATH. The loader re-reads the current corpus version
  // and returns the verdict the restart/resume decision is made from.
  const coverage = await loadRoleMatchCoverage(client, candidateId, { roles: roleInputs });
  const corpusVersion = coverage.currentCorpusVersion;

  if (coverage.state === "current") {
    // Reprocessing unchanged inputs is a no-op: the corpus version proves the
    // titles have not moved, so no scan and no write is needed.
    return {
      candidateId,
      dryRun,
      roles,
      generation: coverage.publishedGeneration ?? "",
      coverageState: coverage.state,
      corpusVersion,
      corpusComplete: true,
      batches: 0,
      scanned: 0,
      matched: 0,
      startedNewGeneration: false,
      status: "complete",
    };
  }

  // Resume ONLY when the loader proved the inputs AND the corpus version are
  // unchanged. Anything else starts a fresh generation at the current version:
  // a partially scanned generation is never relabelled with a newer version.
  const resuming = coverage.resumable;

  const generation = resuming ? (coverage.runningGeneration ?? randomUUID()) : randomUUID();
  let cursor = resuming ? coverage.corpusCursor : null;
  let scanned = resuming ? coverage.scanned : 0;
  let matched = resuming ? coverage.matched : 0;

  const result: MaterializeResult = {
    candidateId,
    dryRun,
    roles,
    generation,
    coverageState: coverage.state,
    corpusVersion,
    corpusComplete: false,
    batches: 0,
    scanned: 0,
    matched: 0,
    startedNewGeneration: !resuming,
    status: "running",
  };

  try {
    // Establish the running row BEFORE any scan, so an EMPTY browseable corpus
    // can still publish (there would otherwise be no running row for the
    // publish RPC to advance).
    if (!dryRun) {
      const { error: startError } = await client.from("candidate_role_match_coverage").upsert(
        runningCoverageRow({
          candidateId,
          generation,
          cursor,
          fingerprint,
          corpusVersion,
          status: "running",
          scanned,
          matched,
        }),
        { onConflict: "candidate_id" },
      );

      if (startError) {
        throw startError;
      }
    }

    for (let batch = 0; batch < maxBatches; batch += 1) {
      // The browseable corpus, mirroring public.candidate_opportunities. The
      // keyset cursor is safe ONLY because a corpus change bumps the version and
      // invalidates the scan; it is not itself freshness evidence.
      let query = client
        .from("vacancies")
        .select("id, raw_title")
        .eq("status", BROWSEABLE_VACANCY_STATUS)
        .in("trust_status", [...BROWSEABLE_TRUST_STATUSES])
        .order("id", { ascending: true })
        .limit(batchSize);

      if (cursor !== null) {
        query = query.gt("id", cursor);
      }

      const { data: vacancyData, error: vacancyError } = await query;

      if (vacancyError) {
        throw vacancyError;
      }

      const vacancies = (vacancyData ?? []) as VacancyRow[];
      result.batches += 1;

      if (vacancies.length > 0) {
        const matches: Array<Record<string, unknown>> = [];

        for (const vacancy of vacancies) {
          const title = vacancy.raw_title ?? "";

          for (const roleName of roles) {
            if (isTitleRelevantToRole(title, roleName)) {
              matches.push({
                candidate_id: candidateId,
                role_name: roleName,
                vacancy_id: vacancy.id,
                generation,
                matcher_version: ROLE_MATCHER_VERSION,
                // The EXACT input this match was derived from, so a later title
                // change is detectable per row. Legacy rows stay NULL.
                input_title: title,
                matched_at: now,
              });
            }
          }
        }

        scanned += vacancies.length;
        matched += matches.length;

        if (!dryRun && matches.length > 0) {
          const { error: writeError } = await client
            .from("candidate_role_matches")
            .upsert(matches, { onConflict: "candidate_id,role_name,vacancy_id,generation" });

          if (writeError) {
            throw writeError;
          }
        }

        if (!dryRun) {
          const { error: progressError } = await client.from("candidate_role_match_coverage").upsert(
            runningCoverageRow({
              candidateId,
              generation,
              cursor: vacancies[vacancies.length - 1].id,
              fingerprint,
              corpusVersion,
              status: "running",
              scanned,
              matched,
            }),
            { onConflict: "candidate_id" },
          );

          if (progressError) {
            throw progressError;
          }
        }

        cursor = vacancies[vacancies.length - 1].id;
      }

      // A SHORT BATCH IS THE END OF THE CORPUS. batchSize bounds the WORK PER
      // INVOCATION, never the corpus itself: the traversal continues on the next
      // run from the stored cursor.
      if (vacancies.length < batchSize) {
        result.corpusComplete = true;
        break;
      }
    }

    result.scanned = scanned;
    result.matched = matched;

    if (result.corpusComplete && !dryRun) {
      // PUBLISH ONLY ON COMPLETION, AND ONLY FOR THE VERSION THE SCAN STARTED AT.
      // The RPC validates the version and advances the pointer in ONE
      // transaction, so a mutation cannot slip between the check and the write.
      const { data: published, error: publishError } = await client.rpc(
        "publish_role_match_coverage",
        {
          p_candidate_id: candidateId,
          p_generation: generation,
          p_expected_corpus_version: corpusVersion,
          p_scanned: scanned,
          p_matched: matched,
        },
      );

      if (publishError) {
        throw publishError;
      }

      if (published === true) {
        result.status = "complete";
      } else {
        // The corpus moved while this scan was running. Never publish it for the
        // new version: record it as incomplete so the next run restarts. The
        // previously published generation is untouched.
        result.status = "stale";
        await client
          .from("candidate_role_match_coverage")
          .update(
            runningCoverageRow({
              candidateId,
              generation,
              cursor,
              fingerprint,
              corpusVersion,
              status: "running",
              scanned,
              matched,
              lastError:
                "the browseable vacancy corpus changed during the scan; this generation was not published and must be restarted",
            }),
          )
          .eq("candidate_id", candidateId)
          .eq("running_generation", generation);
      }
    }

    return result;
  } catch (error) {
    if (!dryRun) {
      // A FAILED SCAN IS NEVER MARKED COMPLETE and never publishes. The previous
      // generation stays readable; the failure is recorded for the operator.
      // Conditional on this generation still running, so a concurrent run's
      // progress is never clobbered.
      await client
        .from("candidate_role_match_coverage")
        .update(
          runningCoverageRow({
            candidateId,
            generation,
            cursor,
            fingerprint,
            corpusVersion,
            status: "failed",
            scanned,
            matched,
            lastError: describeError(error),
          }),
        )
        .eq("candidate_id", candidateId)
        .eq("running_generation", generation);
    }

    result.status = "failed";
    result.scanned = scanned;
    result.matched = matched;
    result.error = describeError(error);
    return result;
  }
}
