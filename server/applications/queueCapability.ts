import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveApplicationAdapter } from "./adapters/registry.js";

/**
 * WHETHER AUTOMATIC APPLICATION IS POSSIBLE AT ALL, right now, for anybody.
 *
 * WHY THIS EXISTS. The Copilot used to advertise queue_applications and render
 * its proposal card unconditionally. Every source with vacancies in production
 * fails at least one of the two halves below, so every approval ended at
 * "Queued 0 of N" while the card was marked done — a button that looked like it
 * worked and could never work. The gates were right; offering the action was not.
 *
 * GLOBAL, NOT PER-CANDIDATE, AND THAT IS DELIBERATE. Queueability is a property
 * of SOURCES: an adapter for the source_code, plus a policy row authorizing
 * discovery and automated application. Nothing candidate-specific can make an
 * otherwise-queueable source queueable. Candidate gates (consent, verified
 * facts, role match, rate limits, exclusions) only narrow WHICH vacancies
 * succeed, and they stay where they belong — at execution time, in
 * evaluateEligibilityGates. Scanning a candidate's whole backlog just to decide
 * whether to show a tool would duplicate planApplication and make the tool's
 * availability flicker per candidate for no gain.
 *
 * THE TWO HALVES ARE INDEPENDENT ON PURPOSE. registry.ts says "a submission
 * channel exists"; the source_policies row says "we are authorized to use it".
 * A source needs both. This mirrors evaluateApplicationSupport and
 * evaluateSourcePolicy exactly, so this can only ever say "yes" when those two
 * gates would also pass.
 *
 * CONSERVATIVE ON ERROR. Any query failure returns "not possible". A missing
 * capability is a missing button, which is recoverable; a wrongly-advertised
 * action produces exactly the dead-end approval this module exists to prevent.
 */

export interface QueueCapability {
  /** True when at least one source with vacancies has an adapter AND an authorizing policy row. */
  canQueue: boolean;
  /** The source_codes that satisfy both halves. Empty when canQueue is false. */
  queueableSources: string[];
}

const NOT_POSSIBLE: QueueCapability = { canQueue: false, queueableSources: [] };

interface VacancySourceRow {
  source_code: string | null;
}

interface PolicyRow {
  source_code: string;
  discovery_allowed: boolean;
  automated_application_allowed: boolean;
}

/**
 * Resolves the capability from live data.
 *
 * Reads which source_codes actually hold vacancies rather than iterating the
 * whole policy table: a registered adapter for a source with no vacancies
 * cannot queue anything, and counting it would advertise a tool that still
 * produces "0 queued".
 */
export async function loadQueueCapability(
  client: Pick<SupabaseClient, "from">,
): Promise<QueueCapability> {
  try {
    const { data: vacancyRows, error: vacancyError } = await client
      .from("vacancies")
      .select("source_code")
      .limit(1000);

    if (vacancyError) {
      return NOT_POSSIBLE;
    }

    const sourceCodes = [
      ...new Set(
        ((vacancyRows ?? []) as VacancySourceRow[])
          .map((row) => row.source_code)
          .filter((code): code is string => typeof code === "string" && code !== ""),
      ),
    ];

    if (sourceCodes.length === 0) {
      return NOT_POSSIBLE;
    }

    const { data: policyRows, error: policyError } = await client
      .from("source_policies")
      .select("source_code, discovery_allowed, automated_application_allowed")
      .in("source_code", sourceCodes);

    if (policyError) {
      return NOT_POSSIBLE;
    }

    const allowed = new Set(
      ((policyRows ?? []) as PolicyRow[])
        .filter((row) => row.discovery_allowed === true && row.automated_application_allowed === true)
        .map((row) => row.source_code),
    );

    const queueableSources = sourceCodes.filter(
      (code) => allowed.has(code) && resolveApplicationAdapter(code).validateSupport({
        vacancy: { sourceCode: code, trustStatus: null, rawTitle: "" },
        candidateId: "",
      }).supported,
    );

    return { canQueue: queueableSources.length > 0, queueableSources };
  } catch {
    return NOT_POSSIBLE;
  }
}
