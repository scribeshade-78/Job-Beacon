import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TOKENIZER_VERSION,
  evidenceFingerprint,
  evidenceTokens,
} from "../../shared/evidenceTokens.js";

/**
 * Bounded, resumable backfill of derived posting-evidence tokens.
 *
 * IT NEVER SUBMITS ANYTHING and never touches candidate intent: it derives
 * tokens from vacancies.raw_title and the latest vacancy_jd_snapshots.clean_text
 * and upserts them. No adapter, no attempt, no task activation, no network call
 * beyond the database.
 *
 * IDEMPOTENT AND RESUMABLE. Rows already current for the same tokenizer version
 * and evidence fingerprint are skipped, so re-running is cheap and safe; the
 * cursor is an offset over vacancy ids, so a run can be repeated with a larger
 * offset to continue. A partially indexed corpus is reported as such — the
 * caller must NOT treat "indexed so far" as "everything is ranked".
 *
 * BOUNDED: at most maxBatches * batchSize vacancies are examined per invocation,
 * and descriptions are read in ONE query per batch rather than one per vacancy.
 */

export interface IndexEvidenceOptions {
  /** Report what would change without writing. */
  dryRun?: boolean;
  /** Vacancies examined per database round trip. */
  batchSize?: number;
  /** How many batches to process before returning. */
  maxBatches?: number;
  /** Where to resume from (number of vacancies already examined). */
  offset?: number;
}

export interface IndexEvidenceResult {
  dryRun: boolean;
  tokenizerVersion: string;
  examined: number;
  indexed: number;
  wouldIndex: number;
  skippedCurrent: number;
  /** Vacancies with no captured description — indexed from the title alone. */
  titleOnly: number;
  /** Vacancies whose token row could not be written. Never silently swallowed. */
  failures: Array<{ vacancyId: string; error: string }>;
  nextOffset: number;
  done: boolean;
}

export const DEFAULT_INDEX_BATCH_SIZE = 100;
export const DEFAULT_INDEX_MAX_BATCHES = 5;

interface VacancyRow {
  id: string;
  raw_title: string | null;
}

interface SnapshotRow {
  id: string;
  vacancy_id: string;
  clean_text: string | null;
  created_at: string;
}

interface TokenRow {
  vacancy_id: string;
  tokenizer_version: string;
  evidence_fingerprint: string;
}

/**
 * The latest captured description per vacancy.
 *
 * Ordered newest-first and reduced in memory so ONE query serves the whole
 * batch; a per-vacancy lookup would be exactly the per-card query pattern this
 * design exists to avoid.
 *
 * DETERMINISTIC BY (created_at, id). The ranked read model compares a token
 * row's recorded snapshot to this same rule, computed in SQL; without a
 * tie-break two snapshots created in the same instant would resolve differently
 * on each side and a row would flicker in and out of "current".
 */
export function isNewerSnapshot(candidate: SnapshotRow, existing: SnapshotRow): boolean {
  if (candidate.created_at !== existing.created_at) {
    return candidate.created_at > existing.created_at;
  }

  return candidate.id > existing.id;
}

export function latestSnapshotByVacancy(rows: readonly SnapshotRow[]): Map<string, SnapshotRow> {
  const latest = new Map<string, SnapshotRow>();

  for (const row of rows) {
    const existing = latest.get(row.vacancy_id);

    if (existing === undefined || isNewerSnapshot(row, existing)) {
      latest.set(row.vacancy_id, row);
    }
  }

  return latest;
}

export async function indexVacancyEvidence(
  client: Pick<SupabaseClient, "from">,
  options: IndexEvidenceOptions = {},
): Promise<IndexEvidenceResult> {
  const dryRun = options.dryRun === true;
  const batchSize = options.batchSize ?? DEFAULT_INDEX_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_INDEX_MAX_BATCHES;
  let offset = options.offset ?? 0;

  const result: IndexEvidenceResult = {
    dryRun,
    tokenizerVersion: TOKENIZER_VERSION,
    examined: 0,
    indexed: 0,
    wouldIndex: 0,
    skippedCurrent: 0,
    titleOnly: 0,
    failures: [],
    nextOffset: offset,
    done: false,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { data: vacancyData, error: vacancyError } = await client
      .from("vacancies")
      .select("id, raw_title")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (vacancyError) {
      throw vacancyError;
    }

    const vacancies = (vacancyData ?? []) as VacancyRow[];
    result.examined += vacancies.length;
    offset += vacancies.length;
    result.nextOffset = offset;

    if (vacancies.length === 0) {
      result.done = true;
      break;
    }

    const vacancyIds = vacancies.map((vacancy) => vacancy.id);

    const { data: snapshotData, error: snapshotError } = await client
      .from("vacancy_jd_snapshots")
      .select("id, vacancy_id, clean_text, created_at")
      .in("vacancy_id", vacancyIds)
      .order("created_at", { ascending: false });

    if (snapshotError) {
      throw snapshotError;
    }

    const snapshots = latestSnapshotByVacancy((snapshotData ?? []) as SnapshotRow[]);

    const { data: tokenData, error: tokenError } = await client
      .from("vacancy_evidence_tokens")
      .select("vacancy_id, tokenizer_version, evidence_fingerprint")
      .in("vacancy_id", vacancyIds);

    if (tokenError) {
      throw tokenError;
    }

    const existing = new Map<string, TokenRow>(
      ((tokenData ?? []) as TokenRow[]).map((row) => [row.vacancy_id, row]),
    );

    const writes: Array<Record<string, unknown>> = [];

    for (const vacancy of vacancies) {
      const snapshot = snapshots.get(vacancy.id) ?? null;
      const input = {
        title: vacancy.raw_title ?? "",
        description: snapshot === null ? null : (snapshot.clean_text ?? null),
      };

      if (snapshot === null || input.description === null || input.description.trim() === "") {
        result.titleOnly += 1;
      }

      const fingerprint = evidenceFingerprint(input);
      const current = existing.get(vacancy.id);

      if (
        current !== undefined &&
        current.tokenizer_version === TOKENIZER_VERSION &&
        current.evidence_fingerprint === fingerprint
      ) {
        result.skippedCurrent += 1;
        continue;
      }

      if (dryRun) {
        result.wouldIndex += 1;
        continue;
      }

      writes.push({
        vacancy_id: vacancy.id,
        jd_snapshot_id: snapshot === null ? null : snapshot.id,
        tokenizer_version: TOKENIZER_VERSION,
        evidence_fingerprint: fingerprint,
        // SQL-comparable copies of the EXACT inputs tokenized, so the ranked view
        // can prove they still match the current title and selected snapshot.
        input_title: input.title,
        input_clean_text: input.description,
        tokens: evidenceTokens(input),
        indexed_at: new Date().toISOString(),
      });
    }

    if (writes.length > 0) {
      const { error: upsertError } = await client
        .from("vacancy_evidence_tokens")
        .upsert(writes, { onConflict: "vacancy_id" });

      if (upsertError) {
        // One failed batch is reported, not swallowed: a silent gap would look
        // like "this posting has no preference evidence".
        for (const write of writes) {
          result.failures.push({ vacancyId: String(write.vacancy_id), error: String(upsertError.message ?? upsertError) });
        }
      } else {
        result.indexed += writes.length;
      }
    }

    if (vacancies.length < batchSize) {
      result.done = true;
      break;
    }
  }

  return result;
}
