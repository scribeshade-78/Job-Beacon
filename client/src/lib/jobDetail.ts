import type { SupabaseClient } from "@supabase/supabase-js";
import { listOpportunitiesByIds, type OpportunitySummary } from "./opportunities";

/**
 * One listing plus the JD text captured for it.
 *
 * WHY THIS IS A SECOND READ. candidate_opportunities (the view the
 * Opportunities panel already reads) deliberately exposes fit and plan columns
 * but NOT the description body — the card never showed it. The full text lives
 * on vacancy_jd_snapshots, which authenticated users can SELECT (RLS policy
 * vacancy_jd_snapshots_select_all, 20260831120000). So the summary is read
 * through the existing data source and the description through the existing
 * table, and no new schema or server route is introduced.
 */

export interface JobDescription {
  /** vacancy_jd_snapshots.clean_text — the full cleaned posting text. */
  cleanText: string;
}

export type LoadJobDetailResult =
  | { kind: "success"; job: OpportunitySummary; description: JobDescription | null }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

const FAILURE_MESSAGE = "Could not load this job. Please try again.";

/**
 * Reads one listing by id, then its latest JD snapshot.
 *
 * A missing snapshot is NOT an error: some sources ship no usable JD text and
 * the fit worker records that as jd_text_available = false. The page says so
 * rather than inventing a description.
 */
export async function loadJobDetail(
  client: Pick<SupabaseClient, "from">,
  jobId: string,
): Promise<LoadJobDetailResult> {
  try {
    const result = await listOpportunitiesByIds(client, [jobId]);

    if (result.kind === "error") {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const job = result.opportunities[0];

    // The view applies its own trust/active filter, so an id that exists but is
    // FLAGGED/BLOCKED/expired reads as not found here — the same set the list
    // can show.
    if (!job) {
      return { kind: "not_found" };
    }

    // The same "latest snapshot for the vacancy" read interviewPrep.ts uses:
    // ordered by created_at desc, at most one row considered.
    const { data, error } = await client
      .from("vacancy_jd_snapshots")
      .select("clean_text")
      .eq("vacancy_id", jobId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const row = data as { clean_text?: unknown } | null;
    const cleanText = row && typeof row.clean_text === "string" ? row.clean_text.trim() : "";

    return {
      kind: "success",
      job,
      description: cleanText === "" ? null : { cleanText: row!.clean_text as string },
    };
  } catch {
    return { kind: "error", message: FAILURE_MESSAGE };
  }
}
