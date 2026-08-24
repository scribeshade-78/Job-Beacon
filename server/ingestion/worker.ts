import type { SupabaseClient } from "@supabase/supabase-js";
import { getDiscoveryAdapter } from "./adapters/registry.js";
import { ingestDiscoveredVacancy, markUnseenVacanciesExpired } from "./ingest.js";
import type { DiscoveredVacancy } from "./types.js";
import { scoreVacancy } from "../trust/scoreVacancy.js";

/**
 * MP-A2.1: every discovery adapter is now registry-formalized (Greenhouse,
 * Lever, Adzuna, USAJOBS) — getDiscoveryAdapter itself throws
 * `No discovery adapter registered for source_code "..."` for an unknown
 * one, so no separate fallback/switch is needed here anymore.
 */
async function discoverForSource(
  sourceCode: string,
  targetKey: string,
  config: Record<string, unknown>,
): Promise<DiscoveredVacancy[]> {
  return getDiscoveryAdapter(sourceCode).discover(targetKey, config as never);
}

export interface RunOneJobResult {
  processed: boolean;
  vacanciesFetched?: number;
  error?: string;
}

/**
 * Claims and processes exactly one ingestion job. Returns
 * `{ processed: false }` when the queue is empty — callers loop on this to
 * drain the queue, or schedule it periodically; this module doesn't run a
 * persistent process itself (no deployment/scheduling infrastructure
 * exists yet in this repo — that's a later-phase concern).
 */
export async function runOneIngestionJob(client: SupabaseClient): Promise<RunOneJobResult> {
  const { data: jobs, error: claimError } = await client.rpc("claim_ingestion_job");

  if (claimError) {
    throw claimError;
  }

  const job = jobs?.[0] as
    | { id: string; source_code: string; vacancy_source_id: string; attempts: number; max_attempts: number }
    | undefined;

  if (!job) {
    return { processed: false };
  }

  const startedAt = Date.now();

  try {
    const { data: vacancySource, error: vsError } = await client
      .from("vacancy_sources")
      .select("id, source_code, target_key, config")
      .eq("id", job.vacancy_source_id)
      .single();

    if (vsError || !vacancySource) {
      throw vsError ?? new Error(`vacancy_source ${job.vacancy_source_id} not found.`);
    }

    const { data: policy, error: policyError } = await client
      .from("source_policies")
      .select("discovery_allowed, kill_switch")
      .eq("source_code", vacancySource.source_code)
      .single();

    if (policyError || !policy) {
      throw policyError ?? new Error(`source_policies row for "${vacancySource.source_code}" not found.`);
    }

    if (!policy.discovery_allowed || policy.kill_switch) {
      throw new Error(
        `Discovery is not permitted for source "${vacancySource.source_code}" (discovery_allowed=${policy.discovery_allowed}, kill_switch=${policy.kill_switch}).`,
      );
    }

    const discovered = await discoverForSource(
      vacancySource.source_code,
      vacancySource.target_key,
      vacancySource.config as Record<string, unknown>,
    );

    const seenVacancyIds: string[] = [];

    for (const item of discovered) {
      const result = await ingestDiscoveredVacancy(client, vacancySource.source_code, vacancySource.id, item);
      seenVacancyIds.push(result.vacancyId);

      try {
        await scoreVacancy(client, result.vacancyId);
      } catch {
        // Trust scoring must never block ingestion — "ingestion must remain
        // available when trust scoring or company resolution is slow or
        // unavailable" is a product invariant. A vacancy whose scoring
        // fails simply keeps its current trust_status (NULL for a newly
        // created row) rather than failing the whole ingestion job and
        // re-running discovery/ingestion for everything already processed
        // in this batch. No error-visibility mechanism is wired for
        // scoring failures specifically yet — that's a real gap, not
        // solved here; source_health_events tracks per-source sync
        // outcomes, not per-vacancy scoring outcomes.
      }
    }

    await markUnseenVacanciesExpired(client, vacancySource.id, seenVacancyIds);

    await client.from("source_health_events").insert({
      source_code: vacancySource.source_code,
      vacancy_source_id: vacancySource.id,
      status: "success",
      vacancies_fetched: discovered.length,
      duration_ms: Date.now() - startedAt,
    });

    await client
      .from("ingestion_jobs")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", job.id);

    return { processed: true, vacanciesFetched: discovered.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await client.from("source_health_events").insert({
      source_code: job.source_code,
      vacancy_source_id: job.vacancy_source_id,
      status: "error",
      error_message: message,
      duration_ms: Date.now() - startedAt,
    });

    const exhausted = job.attempts >= job.max_attempts;

    if (exhausted) {
      // Dead-letter: claim_ingestion_job's WHERE clause never matches
      // 'failed', so this is terminal — visible via source_health_events
      // and this row for manual review, per the skill's "Failed-job
      // visibility and manual retry" requirement.
      await client
        .from("ingestion_jobs")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", job.id);
    } else {
      // Retry with backoff: setting status back to 'pending' would make it
      // immediately reclaimable (claim_ingestion_job's WHERE doesn't check
      // leased_until for 'pending' rows) — staying 'leased' with a future
      // leased_until is what actually delays the retry.
      const backoffMinutes = Math.min(2 ** job.attempts, 60);
      await client
        .from("ingestion_jobs")
        .update({
          status: "leased",
          leased_until: new Date(Date.now() + backoffMinutes * 60_000).toISOString(),
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }

    return { processed: true, error: message };
  }
}