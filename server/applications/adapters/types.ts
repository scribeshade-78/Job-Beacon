import type { SupabaseClient } from "@supabase/supabase-js";

export interface ApplicationSubmissionContext {
  applicationAttemptId: string;
  applicationPlanId: string;
}

export interface ApplicationSubmissionResult {
  evidenceType: string;
  payload: Record<string, unknown>;
}

/**
 * PRD §23.1's ApplicationAdapter role, R4.8 (R7-M2): one implementation per
 * source_code, resolved by resolveApplicationAdapter (./registry.ts).
 * Mirrors server/ingestion's discovery-adapter shape — per-source async
 * functions dispatched by a switch (server/ingestion/ingest.ts's
 * discoverForSource) — rather than a class-based or Map-based registry:
 * that's this codebase's established convention for "one implementation
 * per known provider, resolved by source_code," and reusing it here is a
 * smaller diff than inventing a second registry convention.
 *
 * submit() takes the SupabaseClient (unlike the pre-R7-M2 submissionAdapter.ts
 * stub, which took none) because a real adapter needs it — to read the
 * candidate's confirmed facts/generated resume, to write intermediate
 * evidence mid-submission, etc. — the same reason discoverForSource's
 * per-source functions don't need a client (they call an external HTTP API
 * and return data; ingestDiscoveredVacancy, not the adapter, does the
 * writing) while an application adapter's job is inseparable from reading
 * and writing this candidate's own data.
 */
export interface ApplicationAdapter {
  submit(client: SupabaseClient, context: ApplicationSubmissionContext): Promise<ApplicationSubmissionResult>;
}
