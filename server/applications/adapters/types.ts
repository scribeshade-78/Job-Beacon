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
 * MP-A1's capability-check input: the vacancy fields evaluateEligibilityGates
 * already has in scope (no separate query — reuses the same row source_policy/
 * vacancy_trust/role_match etc. gates already fetched), plus candidateId in
 * case a future real adapter's support depends on candidate-specific state
 * (e.g. a per-candidate employer relationship), not just the source in the
 * abstract.
 */
export interface ApplicationSupportContext {
  vacancy: { sourceCode: string; trustStatus: string | null; rawTitle: string };
  candidateId: string;
}

export interface ApplicationSupportValidation {
  supported: boolean;
  reasonCode?: string;
}

/**
 * PRD §23.1's ApplicationAdapter role, R4.8 (R7-M2), extended by MP-A1 with
 * an explicit capability model: one implementation per source_code, resolved
 * by resolveApplicationAdapter (./registry.ts). Mirrors server/ingestion's
 * discovery-adapter shape — per-source async functions dispatched by a
 * switch (server/ingestion/ingest.ts's discoverForSource) — rather than a
 * class-based or Map-based registry: that's this codebase's established
 * convention for "one implementation per known provider, resolved by
 * source_code," and reusing it here is a smaller diff than inventing a
 * second registry convention.
 *
 * sourceCode/displayName/isAutomatedSubmissionSupported/validateSupport
 * (MP-A1) let eligibilityGate.ts's application_support gate ask the adapter
 * itself whether it's supported, instead of the gate identity-comparing
 * against the unsupportedAdapter singleton — the adapter is now the single
 * source of truth for its own capability, not the gate re-deriving it.
 * isAutomatedSubmissionSupported is the adapter's static capability flag;
 * validateSupport() is what the gate actually calls, since a real adapter
 * may need to combine that flag with per-vacancy/per-candidate context (this
 * codebase has no such case yet, but the seam exists for one without another
 * interface change).
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
  sourceCode: string;
  displayName: string;
  isAutomatedSubmissionSupported: boolean;
  validateSupport(context: ApplicationSupportContext): ApplicationSupportValidation;
  submit(client: SupabaseClient, context: ApplicationSubmissionContext): Promise<ApplicationSubmissionResult>;
}
