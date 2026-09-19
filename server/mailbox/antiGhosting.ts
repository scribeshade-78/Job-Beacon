import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import {
  generateFollowUpDraft,
  MalformedFollowUpError,
  ApplicationFactsUnavailableError,
} from "./followUpGenerator.js";
import { NoConfirmedFactsError, UncitedClaimError, FabricatedContentError } from "../applications/resumeGenerator.js";

/**
 * Task C1 — anti-ghosting: find applications that have gone cold and draft a
 * follow-up for each.
 *
 * WHERE THE DETECTION LIVES. In the database, as find_ghosted_attempts(): the
 * "no reply" condition is a NOT EXISTS over messages joined to their
 * classification, and expressing that through PostgREST's embedded-resource
 * filters produces something neither readable nor testable. Putting it in SQL
 * also means the 7-day window and the reply rule are one artefact that can be
 * asserted directly, rather than a filter chain this module has to build
 * correctly on every call.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No sending, no UI, no scheduling. This
 * phase produces drafts a candidate would review; whether anything ever sends
 * them is a later phase with its own decisions (which address, from which
 * mailbox, with what consent). Nothing here writes to a mailbox or an
 * application_attempts status.
 */

export const DEFAULT_MIN_AGE_DAYS = 7;
export const DEFAULT_DRAFT_LIMIT = 20;

export interface GhostedAttempt {
  applicationAttemptId: string;
  candidateId: string;
  vacancyId: string;
  submittedAt: string;
  daysSinceSubmission: number;
}

/**
 * Reads the detector. The window and the limit are parameters so a test — and a
 * future caller — can ask a different question without a second query.
 */
export async function findGhostedAttempts(
  client: SupabaseClient,
  options: { minAgeDays?: number; limit?: number } = {},
): Promise<GhostedAttempt[]> {
  const { data, error } = await client.rpc("find_ghosted_attempts", {
    p_min_age_days: options.minAgeDays ?? DEFAULT_MIN_AGE_DAYS,
    p_limit: options.limit ?? DEFAULT_DRAFT_LIMIT,
  });

  if (error) {
    throw error;
  }

  return ((data ?? []) as Array<{
    application_attempt_id: string;
    candidate_id: string;
    vacancy_id: string;
    submitted_at: string;
    days_since_submission: number;
  }>).map((row) => ({
    applicationAttemptId: row.application_attempt_id,
    candidateId: row.candidate_id,
    vacancyId: row.vacancy_id,
    submittedAt: row.submitted_at,
    daysSinceSubmission: row.days_since_submission,
  }));
}

export interface FollowUpSweepOutcome {
  applicationAttemptId: string;
  daysSinceSubmission: number;
  outcome: "drafted" | "skipped" | "failed";
  /** Present when drafted. */
  draftId?: string;
  /** Present when failed — the generator's own reason, never a generic one. */
  error?: string;
  /** Present when skipped. */
  skippedBecause?: string;
}

export interface FollowUpSweepResult {
  detected: number;
  drafted: number;
  failed: number;
  outcomes: FollowUpSweepOutcome[];
}

export interface FollowUpSweepDeps {
  openai: Pick<OpenAI, "chat">;
  /** Injected in tests so the detector can be driven without a database. */
  findGhosted?: typeof findGhostedAttempts;
  /** Injected in tests so drafting can be exercised without a model. */
  generate?: typeof generateFollowUpDraft;
}

/**
 * Detects ghosted applications and drafts a follow-up for each.
 *
 * NEVER THROWS FOR A PER-ATTEMPT FAILURE. One application whose generation
 * fails must not stop the sweep — the same "isolate per item, let the caller
 * continue" shape runOneApplicationAttempt and runOneIngestionJob use. Only a
 * failure of the detection query itself propagates, because there is no
 * per-attempt outcome to attribute it to.
 *
 * A FAILED GENERATION WRITES NOTHING. No draft row is inserted for an attempt
 * whose follow-up the honesty gate refused, so the attempt stays detectable and
 * a later sweep retries it. Inserting a placeholder would both hide the failure
 * and permanently exclude the attempt through the "already drafted" rule.
 */
export async function runFollowUpSweep(
  client: SupabaseClient,
  deps: FollowUpSweepDeps,
  options: { minAgeDays?: number; limit?: number } = {},
): Promise<FollowUpSweepResult> {
  const findGhosted = deps.findGhosted ?? findGhostedAttempts;
  const generate = deps.generate ?? generateFollowUpDraft;

  const attempts = await findGhosted(client, options);
  const outcomes: FollowUpSweepOutcome[] = [];

  for (const attempt of attempts) {
    try {
      const draft = await generate(client, { openai: deps.openai }, {
        candidateId: attempt.candidateId,
        vacancyId: attempt.vacancyId,
        submittedAt: attempt.submittedAt,
        daysSinceSubmission: attempt.daysSinceSubmission,
      });

      const { data: inserted, error: insertError } = await client
        .from("follow_up_drafts")
        .insert({
          application_attempt_id: attempt.applicationAttemptId,
          draft_text: draft.text,
          status: "pending_review",
          model_version: draft.modelVersion,
          prompt_version: draft.promptVersion,
          generated_at: draft.metadata.generatedAt,
          metadata: draft.metadata,
        })
        .select("id")
        .single();

      if (insertError || !inserted) {
        // A unique-violation here means another sweep drafted this attempt
        // first. That is not a failure — the draft exists, which is the goal.
        outcomes.push({
          applicationAttemptId: attempt.applicationAttemptId,
          daysSinceSubmission: attempt.daysSinceSubmission,
          outcome: "skipped",
          skippedBecause: insertError?.message ?? "no row returned",
        });
        continue;
      }

      outcomes.push({
        applicationAttemptId: attempt.applicationAttemptId,
        daysSinceSubmission: attempt.daysSinceSubmission,
        outcome: "drafted",
        draftId: (inserted as { id: string }).id,
      });
    } catch (error) {
      outcomes.push({
        applicationAttemptId: attempt.applicationAttemptId,
        daysSinceSubmission: attempt.daysSinceSubmission,
        outcome: "failed",
        error: describeGenerationFailure(error),
      });
    }
  }

  return {
    detected: attempts.length,
    drafted: outcomes.filter((outcome) => outcome.outcome === "drafted").length,
    failed: outcomes.filter((outcome) => outcome.outcome === "failed").length,
    outcomes,
  };
}

/**
 * Turns a generator failure into something a caller can act on.
 *
 * The gate's errors say which fact or paragraph was refused, and that detail is
 * the whole value of having refused rather than sent: collapsing it to
 * "generation failed" would leave an operator with a number and no lead.
 */
function describeGenerationFailure(error: unknown): string {
  if (
    error instanceof UncitedClaimError ||
    error instanceof FabricatedContentError ||
    error instanceof MalformedFollowUpError ||
    error instanceof NoConfirmedFactsError ||
    error instanceof ApplicationFactsUnavailableError
  ) {
    return `${error.name}: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
