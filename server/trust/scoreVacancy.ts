import type { SupabaseClient } from "@supabase/supabase-js";
import { applyHardBlocks } from "./applyHardBlocks.js";
import { evaluateHardBlocks, type HardBlockSignals } from "./hardBlocks.js";
import { evaluatePositiveReasonCodes, type PositiveReasonCodeSignals } from "./positiveReasonCodes.js";
import { computeTrustScore, type TrustScoreSignals } from "./trustScore.js";
import { enqueueFitJobsForVacancy } from "../opportunities/enqueue.js";

const TRUST_SCORE_POLICY_VERSION = "r3-trust-score-v2";

type NonBlockedStatus = "VERIFIED" | "VERIFIED_INCOMPLETE" | "UNDER_REVIEW" | "FLAGGED";

export type ScoreVacancyOutcome =
  | { status: "BLOCKED"; reasonCodes: string[] }
  | { status: NonBlockedStatus; score: number; reasonCodes: string[] };

/**
 * Score buckets agreed for R3.4: 80+ VERIFIED, 50-79 UNDER_REVIEW, below 50
 * FLAGGED. This is the pure score-to-label mapping and has no knowledge of
 * sources; see resolveStatus for the one adjustment applied on top of it.
 *
 * EXPIRED_REMOVED and ACTION_REQUIRED are still never produced here — they
 * describe states this function has no signal for.
 */
function statusForScore(score: number): NonBlockedStatus {
  if (score >= 80) return "VERIFIED";
  if (score >= 50) return "UNDER_REVIEW";
  return "FLAGGED";
}

/**
 * Turns the score's bucket into the status actually recorded, honouring a
 * source's declaration that its imports are legitimately incomplete.
 *
 * WHAT VERIFIED_INCOMPLETE MEANS, in this schema's own vocabulary (PRD §12.1):
 * "legitimate but some non-critical fields missing" — as distinct from
 * UNDER_REVIEW's "we could not establish that this employer is who the listing
 * says". Before this, the status could never be produced by scoring at all; its
 * own comment had recorded that as deferred to R5, and intake worked around it
 * by writing vacancies.trust_status itself, which left it disagreeing with
 * vacancy_trust_scores.status for every row it touched.
 *
 * THE RULE IS DELIBERATELY NARROW. It only relabels an UNDER_REVIEW score:
 *
 *   * VERIFIED is never downgraded — a source's declaration cannot take away a
 *     status the vacancy's own score earned.
 *   * FLAGGED is never upgraded — that bucket means the score itself found
 *     something wrong, and no source-level declaration should be able to turn a
 *     flagged listing into an eligible one. This is the line that matters: the
 *     flag suppresses an "unproven" label, never a negative finding.
 *
 * Both outcomes are then written ONCE, to both tables, by the existing code
 * below — so there is nothing left to diverge.
 *
 * Exported so the rule can be pinned directly. Every branch below is reachable
 * except FLAGGED: with the signals currently wired, no vacancy that clears the
 * hard blocks scores below 53 (measured — the scam/content, moderator-history
 * and cross-source dimensions are all still unwired, per TrustScoreSignals).
 * The FLAGGED guard is therefore correct but not yet exercised by any real
 * input, which is exactly why it needs a test that does not depend on finding
 * one.
 */
export function resolveStatus(scored: NonBlockedStatus, partialVerificationAllowed: boolean): NonBlockedStatus {
  if (partialVerificationAllowed && scored === "UNDER_REVIEW") {
    return "VERIFIED_INCOMPLETE";
  }

  return scored;
}

interface VacancyRow {
  id: string;
  authoritative_url: string;
  status: "active" | "expired" | "removed";
  last_seen_at: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_source: "employer_disclosed" | "estimated" | null;
  source_code: string;
  company_id: string | null;
  trust_status: string | null;
}

export interface ScoreVacancyDeps {
  /**
   * Injected so scoreVacancy.test.ts can assert the transition-into-VERIFIED
   * enqueue without a live fit_analysis_jobs path. Defaults to the real
   * enqueue.
   */
  enqueueFitJobs?: (client: SupabaseClient, vacancyId: string) => Promise<unknown>;
}

/**
 * Fetches the DB context one vacancy needs to be scored (the vacancy row,
 * its resolved company's domains, and its source's policy flags), then
 * scores it: hard blocks first (PRD §12.2 — "hard-block rules override the
 * numeric result"); only if none fire does the R3.3 weighted score run,
 * mapped to a status bucket and paired with whichever §12.4 positive
 * reason codes are confirmable from real signals today.
 */
export async function scoreVacancy(
  client: SupabaseClient,
  vacancyId: string,
  deps: ScoreVacancyDeps = {},
): Promise<ScoreVacancyOutcome> {
  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select(
      "id, authoritative_url, status, last_seen_at, salary_min, salary_max, salary_source, source_code, company_id, trust_status",
    )
    .eq("id", vacancyId)
    .single();

  if (vacancyError || !vacancy) {
    throw vacancyError ?? new Error(`Vacancy ${vacancyId} not found.`);
  }

  const row = vacancy as VacancyRow;

  let companyDomain: string | null = null;
  let companyCareerDomain: string | null = null;

  if (row.company_id) {
    const { data: company, error: companyError } = await client
      .from("companies")
      .select("domain, career_domain")
      .eq("id", row.company_id)
      .single();

    if (companyError || !company) {
      throw companyError ?? new Error(`Company ${row.company_id} not found for vacancy ${vacancyId}.`);
    }

    companyDomain = (company as { domain: string | null }).domain;
    companyCareerDomain = (company as { career_domain: string | null }).career_domain;
  }

  const { data: policy, error: policyError } = await client
    .from("source_policies")
    .select("discovery_allowed, kill_switch, employer_identity_authoritative, partial_verification_allowed")
    .eq("source_code", row.source_code)
    .single();

  if (policyError || !policy) {
    throw policyError ?? new Error(`source_policies row for "${row.source_code}" not found.`);
  }

  const sourceDiscoveryAllowed = (policy as { discovery_allowed: boolean }).discovery_allowed;
  const sourceKillSwitch = (policy as { kill_switch: boolean }).kill_switch;
  // Read defensively: the column is NOT NULL with a false default, but this
  // code runs against databases that may predate
  // 20260917120000_source_authority_employer_identity.sql, and a missing
  // signal must degrade to the old (0) behaviour rather than throw mid-score.
  const sourceAuthoritativeForEmployer =
    (policy as { employer_identity_authoritative?: boolean }).employer_identity_authoritative === true;
  // Read defensively for the same reason: the column is NOT NULL with a false
  // default, but this code also runs against databases that predate
  // 20260917220000, and an absent flag must mean "no adjustment", not a throw.
  const partialVerificationAllowed =
    (policy as { partial_verification_allowed?: boolean }).partial_verification_allowed === true;

  const hardBlockSignals: HardBlockSignals = {
    authoritativeUrl: row.authoritative_url,
    companyDomain,
    companyCareerDomain,
    sourceDiscoveryAllowed,
    sourceKillSwitch,
    vacancyStatus: row.status,
  };

  const hardBlockReasonCodes = evaluateHardBlocks(hardBlockSignals);

  if (hardBlockReasonCodes.length > 0) {
    await applyHardBlocks(client, vacancyId, hardBlockSignals);
    return { status: "BLOCKED", reasonCodes: hardBlockReasonCodes };
  }

  const trustScoreSignals: TrustScoreSignals = {
    authoritativeUrl: row.authoritative_url,
    companyDomain,
    companyCareerDomain,
    sourceAuthoritativeForEmployer,
    sourceDiscoveryAllowed,
    sourceKillSwitch,
    vacancyStatus: row.status,
    lastSeenAt: row.last_seen_at,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
  };

  const { total } = computeTrustScore(trustScoreSignals);
  const bucket = resolveStatus(statusForScore(total), partialVerificationAllowed);

  const positiveReasonCodeSignals: PositiveReasonCodeSignals = {
    authoritativeUrl: row.authoritative_url,
    companyDomain,
    companyCareerDomain,
    sourceCode: row.source_code,
    salarySource: row.salary_source,
    vacancyStatus: row.status,
    lastSeenAt: row.last_seen_at,
  };

  const positiveReasonCodes = evaluatePositiveReasonCodes(positiveReasonCodeSignals);

  const { data: trustScoreRow, error: scoreError } = await client
    .from("vacancy_trust_scores")
    .insert({
      vacancy_id: vacancyId,
      status: bucket,
      score: total,
      policy_version: TRUST_SCORE_POLICY_VERSION,
    })
    .select("id")
    .single();

  if (scoreError || !trustScoreRow) {
    throw scoreError ?? new Error(`Failed to insert vacancy_trust_scores for vacancy ${vacancyId} — no row returned.`);
  }

  if (positiveReasonCodes.length > 0) {
    const { error: flagsError } = await client.from("vacancy_flags").insert(
      positiveReasonCodes.map((reasonCode) => ({
        vacancy_trust_score_id: (trustScoreRow as { id: string }).id,
        reason_code: reasonCode,
      })),
    );

    if (flagsError) {
      throw flagsError;
    }
  }

  const { error: updateError } = await client
    .from("vacancies")
    .update({ trust_status: bucket })
    .eq("id", vacancyId);

  if (updateError) {
    throw updateError;
  }

  // Phase 2.1: a vacancy *entering* VERIFIED enqueues a fit analysis for
  // every active candidate. Phase 2.3b broadens that to ANY trust bucket
  // transition, because the stored priority score's company_credibility
  // factor reads vacancy_trust_scores.score — a vacancy that moves
  // VERIFIED -> UNDER_REVIEW (or back) has a stale stored score until it is
  // re-analysed.
  //
  // Still guarded on a real transition: scoreVacancy runs on every
  // ingestion pass, so re-scoring a vacancy whose bucket did not move must
  // not re-enqueue. Same-bucket numeric drift (e.g. VERIFIED 82 -> 95) is
  // deliberately NOT caught in v1 — it would need a prior-score fetch and a
  // threshold, for a 5%-weight factor.
  //
  // Wrapped so an enqueue failure never blocks scoring/ingestion (the
  // "ingestion must remain available when trust scoring or company
  // resolution is slow" invariant — the ingestion worker already wraps its
  // scoreVacancy call the same way).
  if (bucket !== row.trust_status) {
    try {
      await (deps.enqueueFitJobs ?? enqueueFitJobsForVacancy)(client, vacancyId);
    } catch (error) {
      console.error("[trust:scoreVacancy] fit enqueue failed", {
        vacancyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { status: bucket, score: total, reasonCodes: positiveReasonCodes };
}
