import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTitleRelevantToRole } from "../../shared/roleTaxonomy.js";
import { evidenceFingerprint } from "../../shared/evidenceTokens.js";

/**
 * Materialises which of a candidate's SELECTED ROLES each browseable vacancy
 * matches, using the AUTHORITATIVE shared matcher.
 *
 * WHY THIS IS THE ONLY CORRECT WAY. Qualifier ranking may count a preference only
 * for a role the vacancy actually matches, and that rule is
 * isTitleRelevantToRole — TypeScript. SQL cannot call it, so the matches are
 * computed here and persisted, and ordering in SQL becomes a plain join. Any
 * keyword approximation in SQL would be a second matcher, which is not approved.
 *
 * IT NEVER CONSENTS TO ANYTHING. This is manual matching: it needs no automation
 * consent, no paid plan and no parsed resume. It creates no attempt, submits
 * nothing and activates no task.
 *
 * SPARSE AND COVERAGE-SCOPED. Only matching pairs are written. An absent pair is
 * UNKNOWN until a scan with the same role inputs, matcher version and corpus
 * boundary COMPLETES; the published generation is advanced only then, so a
 * partial or failed scan never destroys usable data.
 */

/** Bump when the matching rule changes; invalidates completed coverage. */
export const ROLE_MATCHER_VERSION = "role-taxonomy-v1";

export const DEFAULT_MATCH_BATCH_SIZE = 200;
export const DEFAULT_MATCH_MAX_BATCHES = 5;

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

export interface MaterializeResult {
  candidateId: string;
  dryRun: boolean;
  roles: string[];
  /** The generation this run wrote into (or would have). */
  generation: string;
  /** Whether the corpus traversal reached its end during this invocation. */
  corpusComplete: boolean;
  batches: number;
  scanned: number;
  matched: number;
  /** Set when the previous published coverage was invalidated by this run. */
  startedNewGeneration: boolean;
  status: "complete" | "running" | "failed";
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
  matcher_version: string;
  status: string;
  scanned: number;
  matched: number;
}

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

export async function materializeCandidateRoleMatches(
  client: Pick<SupabaseClient, "from">,
  candidateId: string,
  options: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const dryRun = options.dryRun === true;
  const batchSize = options.batchSize ?? DEFAULT_MATCH_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MATCH_MAX_BATCHES;
  const now = new Date().toISOString();

  const { data: roleData, error: roleError } = await client
    .from("candidate_selected_roles")
    .select("role_name")
    .eq("candidate_id", candidateId);

  if (roleError) {
    throw roleError;
  }

  const roles = rolesFrom(roleData);
  const fingerprint = roleInputFingerprint(roles.map((roleName) => ({ roleName })));

  const { data: coverageData, error: coverageError } = await client
    .from("candidate_role_match_coverage")
    .select(
      "published_generation, running_generation, corpus_cursor, corpus_complete, role_input_fingerprint, matcher_version, status, scanned, matched",
    )
    .eq("candidate_id", candidateId)
    .maybeSingle();

  if (coverageError) {
    throw coverageError;
  }

  const coverage = (coverageData ?? null) as CoverageRow | null;

  // A RUNNING scan is resumable ONLY while its inputs still match. A role change,
  // a matcher version change or a completed scan starts a NEW generation, so the
  // old matches stay published until the new one completes.
  const inputsMatch =
    coverage !== null &&
    coverage.role_input_fingerprint === fingerprint &&
    coverage.matcher_version === ROLE_MATCHER_VERSION;

  const resuming = coverage !== null && coverage.status === "running" && inputsMatch && !coverage.corpus_complete;

  const generation = dryRun
    ? (resuming ? (coverage?.running_generation ?? randomUUID()) : randomUUID())
    : resuming
      ? (coverage?.running_generation ?? randomUUID())
      : randomUUID();

  let cursor: string | null = resuming ? coverage?.corpus_cursor ?? null : null;
  let scanned = resuming ? (coverage?.scanned ?? 0) : 0;
  let matched = resuming ? (coverage?.matched ?? 0) : 0;

  const result: MaterializeResult = {
    candidateId,
    dryRun,
    roles,
    generation,
    corpusComplete: false,
    batches: 0,
    scanned: 0,
    matched: 0,
    startedNewGeneration: !resuming,
    status: "running",
  };

  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Keyset traversal on vacancy id: stable while the corpus changes, because
      // new vacancies have higher ids and are simply picked up later, and a
      // deleted vacancy stops appearing instead of shifting everything back.
      let query = client
        .from("vacancies")
        .select("id, raw_title")
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
            {
              candidate_id: candidateId,
              running_generation: generation,
              corpus_cursor: vacancies[vacancies.length - 1].id,
              corpus_complete: false,
              role_input_fingerprint: fingerprint,
              matcher_version: ROLE_MATCHER_VERSION,
              status: "running",
              scanned,
              matched,
              started_at: now,
              updated_at: new Date().toISOString(),
            },
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
      // PUBLISH ONLY ON COMPLETION. Advancing published_generation here is what
      // makes readers safe: until this point the previous generation stays
      // published, and a missing pair is UNKNOWN rather than "not relevant".
      const { error: publishError } = await client.from("candidate_role_match_coverage").upsert(
        {
          candidate_id: candidateId,
          published_generation: generation,
          running_generation: null,
          corpus_cursor: cursor,
          corpus_complete: true,
          role_input_fingerprint: fingerprint,
          matcher_version: ROLE_MATCHER_VERSION,
          status: "complete",
          scanned,
          matched,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "candidate_id" },
      );

      if (publishError) {
        throw publishError;
      }

      result.status = "complete";
    }

    return result;
  } catch (error) {
    if (!dryRun) {
      // A FAILED SCAN IS NEVER MARKED COMPLETE and never publishes. The previous
      // generation stays readable; the failure is recorded for the operator.
      await client.from("candidate_role_match_coverage").upsert(
        {
          candidate_id: candidateId,
          running_generation: generation,
          corpus_cursor: cursor,
          corpus_complete: false,
          role_input_fingerprint: fingerprint,
          matcher_version: ROLE_MATCHER_VERSION,
          status: "failed",
          scanned,
          matched,
          last_error: describeError(error),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "candidate_id" },
      );
    }

    result.status = "failed";
    result.scanned = scanned;
    result.matched = matched;
    result.error = describeError(error);
    return result;
  }
}
