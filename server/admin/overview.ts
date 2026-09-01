import type { SupabaseClient } from "@supabase/supabase-js";
import { getModerationQueue } from "../moderation/queue.js";

export interface AdminOverview {
  openModerationCases: number;
  activeSources: number;
  totalCandidates: number;
}

/**
 * R8.1 Overview section — three real counts only. MRR and error/unresolved
 * counts are deliberately not here: no subscriptions or error_events table
 * exists yet (see the R8.1 design doc's schema-gap findings). "Active"
 * source means kill_switch is off, the same operational meaning that
 * column's own migration comment defines (true = discovery must stop).
 */
export async function getAdminOverview(client: SupabaseClient): Promise<AdminOverview> {
  const [queue, sourcesResult, candidatesResult] = await Promise.all([
    getModerationQueue(client),
    client.from("source_policies").select("source_code", { count: "exact", head: true }).eq("kill_switch", false),
    client.from("candidate_profiles").select("id", { count: "exact", head: true }),
  ]);

  if (sourcesResult.error) {
    throw sourcesResult.error;
  }

  if (candidatesResult.error) {
    throw candidatesResult.error;
  }

  return {
    openModerationCases: queue.length,
    activeSources: sourcesResult.count ?? 0,
    totalCandidates: candidatesResult.count ?? 0,
  };
}
