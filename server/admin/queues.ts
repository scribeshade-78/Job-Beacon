import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Queue observability and dead-letter retry for the three Postgres lease queues
 * (PRD §23): ingestion_jobs, fit_analysis_jobs and company_registry_lookup_jobs.
 *
 * ALL THREE SHARE ONE SHAPE, which is why one module reads them: same status
 * vocabulary ('pending' | 'leased' | 'done' | 'failed'), same attempts /
 * max_attempts / leased_until / last_error columns, same 5-minute lease, and a
 * claim RPC built from the identical FOR UPDATE SKIP LOCKED query. What differs
 * is only what a job points at, which is the per-queue descriptor below.
 *
 * WHY COUNTS RATHER THAN A GROUP BY. PostgREST cannot GROUP BY without a view or
 * an RPC, and adding one is a migration. Each status count is therefore its own
 * head-only COUNT, which the (status, leased_until) index on every one of these
 * tables covers. That is several round-trips per queue and it is a deliberate
 * trade against a schema change for a read an operator makes on demand.
 */

export type QueueName = "ingestion_jobs" | "fit_analysis_jobs" | "company_registry_lookup_jobs";

export const QUEUE_NAMES: readonly QueueName[] = [
  "ingestion_jobs",
  "fit_analysis_jobs",
  "company_registry_lookup_jobs",
];

export function isQueueName(value: unknown): value is QueueName {
  return typeof value === "string" && (QUEUE_NAMES as readonly string[]).includes(value);
}

export type QueueJobStatus = "pending" | "leased" | "done" | "failed";

export const QUEUE_JOB_STATUSES: readonly QueueJobStatus[] = ["pending", "leased", "done", "failed"];

/** How many dead-lettered rows per queue the console shows. */
export const DEAD_LETTER_LIMIT = 10;

export type QueueCounts = Record<QueueJobStatus, number>;

export interface DeadLetterJob {
  id: string;
  /** A queue-specific one-line identity, because a uuid tells an operator nothing. */
  label: string;
  attempts: number;
  maxAttempts: number;
  /** The terminal failure the worker recorded. Null only if the column was never written. */
  lastError: string | null;
  updatedAt: string | null;
}

export interface QueueSummary {
  queue: QueueName;
  counts: QueueCounts;
  /** created_at of the oldest 'pending' row — how long the queue has been waiting. Null when nothing is pending. */
  oldestPendingAt: string | null;
  deadLetters: DeadLetterJob[];
}

export interface QueuesOverview {
  queues: QueueSummary[];
  /** Echoed so the UI can label the list honestly rather than assuming a size. */
  deadLetterLimit: number;
}

interface QueueDescriptor {
  deadLetterColumns: string;
  label: (row: Record<string, unknown>) => string;
}

function shortId(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 8) : "unknown";
}

const DESCRIPTORS: Record<QueueName, QueueDescriptor> = {
  ingestion_jobs: {
    deadLetterColumns: "id, source_code, vacancy_source_id, attempts, max_attempts, last_error, updated_at",
    // The source is the actionable half: an operator retries a fetch for a source.
    label: (row) => String(row.source_code ?? "unknown source"),
  },
  fit_analysis_jobs: {
    deadLetterColumns: "id, candidate_id, vacancy_id, attempts, max_attempts, last_error, updated_at",
    label: (row) => "candidate " + shortId(row.candidate_id) + " to vacancy " + shortId(row.vacancy_id),
  },
  company_registry_lookup_jobs: {
    deadLetterColumns: "id, company_id, cin, attempts, max_attempts, last_error, updated_at",
    label: (row) => "CIN " + String(row.cin ?? "unknown"),
  },
};

async function countByStatus(client: SupabaseClient, queue: QueueName, status: QueueJobStatus): Promise<number> {
  const { count, error } = await client
    .from(queue)
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  if (error) {
    throw error;
  }

  return count ?? 0;
}

export async function getQueueSummary(
  client: SupabaseClient,
  queue: QueueName,
  deadLetterLimit: number = DEAD_LETTER_LIMIT,
): Promise<QueueSummary> {
  const descriptor = DESCRIPTORS[queue];

  const [pending, leased, done, failed, oldestResult, deadLetterResult] = await Promise.all([
    countByStatus(client, queue, "pending"),
    countByStatus(client, queue, "leased"),
    countByStatus(client, queue, "done"),
    countByStatus(client, queue, "failed"),
    client
      .from(queue)
      .select("created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    client
      .from(queue)
      .select(descriptor.deadLetterColumns)
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(deadLetterLimit),
  ]);

  if (oldestResult.error) {
    throw oldestResult.error;
  }

  if (deadLetterResult.error) {
    throw deadLetterResult.error;
  }

  const oldest = oldestResult.data as { created_at: string } | null;
  // The untyped client types a dynamic column list as possibly a
  // GenericStringError[], so this goes through unknown rather than straight to
  // the row shape.
  const rows = (deadLetterResult.data ?? []) as unknown as Array<Record<string, unknown>>;

  return {
    queue,
    counts: { pending, leased, done, failed },
    oldestPendingAt: oldest?.created_at ?? null,
    deadLetters: rows.map((row) => ({
      id: String(row.id),
      label: descriptor.label(row),
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 0),
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    })),
  };
}

/** Every queue, read concurrently — one slow count must not serialise the others. */
export async function listQueues(client: SupabaseClient): Promise<QueuesOverview> {
  const queues = await Promise.all(
    QUEUE_NAMES.map((queue) => getQueueSummary(client, queue, DEAD_LETTER_LIMIT)),
  );

  return { queues, deadLetterLimit: DEAD_LETTER_LIMIT };
}

/**
 * Re-arms a dead-lettered row in place: back to 'pending' with its attempt count
 * reset, so the next claim picks it up.
 *
 * The update is conditioned on status = 'failed', which is what makes "nothing
 * matched" meaningful: a wrong id and a row that is not actually dead-lettered
 * are both refused rather than silently reported as success. Re-arming has no
 * other side effect on purpose — it does not run the worker, so an operator
 * chooses when to spend the fetch, and this cannot dispatch anything by itself.
 */
export async function rearmFailedJob(
  client: SupabaseClient,
  queue: QueueName,
  jobId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from(queue)
    .update({
      status: "pending",
      attempts: 0,
      leased_until: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "failed")
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
}
