import type { ApplicationAdapter } from "./types.js";
import { unsupportedAdapter } from "./unsupportedAdapter.js";

/**
 * Resolves a submission adapter by source_code — same "switch keyed by
 * source_code, default falls back" shape as
 * server/ingestion/ingest.ts's discoverForSource, reused instead of
 * inventing a Map-based or class-based registry (this codebase's
 * established convention). Deterministic: the same source_code always
 * resolves to the same adapter reference.
 *
 * Every source_code resolves to unsupportedAdapter today — no real
 * per-source case exists yet, matching source_policies.automated_application_allowed
 * being false for every row (R2's explicit decision, still true as of
 * R7-M2). Add a real `case "greenhouse":` (etc.) here only once that
 * source has both an authorized submission channel (employer credentials
 * or a permitted hosted-form flow, PRD §16.2) and its own
 * source_policies.automated_application_allowed = true — this function is
 * the seam, not a place to route work that has no authorized destination.
 */
export function resolveApplicationAdapter(sourceCode: string): ApplicationAdapter {
  switch (sourceCode) {
    default:
      return unsupportedAdapter;
  }
}
