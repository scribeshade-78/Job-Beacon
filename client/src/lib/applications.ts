import type { SupabaseClient } from "@supabase/supabase-js";
import {
  describeApplicationEvidence,
  type ApplicationEvidenceRow,
  type ApplicationEvidenceView,
} from "./applicationEvidence";
import { isResponseCategory, type ResponseCategory } from "../../../shared/priorityScore";

/**
 * §16.4 worker lifecycle states (application_attempts.status check
 * constraint) — kept in sync manually, same precedent as
 * EXCLUSION_CATEGORIES, since the client can't import the server's
 * ACTIVE_ATTEMPT_STATUSES across the client/server tsconfig boundary.
 */
export const APPLICATION_ATTEMPT_STATUSES = [
  "pending",
  // Task U: held for the candidate's approval. It is a real lifecycle state,
  // not a derived one — the claim query in claim_application_attempt() will not
  // lease a row in it until the candidate approves.
  "pending_review",
  "leased",
  "succeeded",
  "failed",
  "action_required",
  "cancelled",
] as const;

export type ApplicationAttemptStatus = (typeof APPLICATION_ATTEMPT_STATUSES)[number];

/**
 * How each lifecycle status reads to the candidate.
 *
 * The panel used to print the raw column value, which was tolerable while
 * every value was a single lowercase word. "pending_review" is not: shown
 * as-is it looks like a database token rather than the one status the
 * candidate is actually expected to act on.
 */
export const ATTEMPT_STATUS_LABELS: Record<ApplicationAttemptStatus, string> = {
  pending: "Queued",
  pending_review: "Awaiting your review",
  leased: "Submitting",
  succeeded: "Submitted",
  failed: "Could not be submitted",
  action_required: "Needs your input",
  cancelled: "Cancelled",
};

export interface ApplicationAttemptSummary {
  id: string;
  status: ApplicationAttemptStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * What actually happened to this attempt, already reduced to safe,
   * candidate-facing copy. Empty until the worker has recorded something —
   * which is the normal state before any submission has run.
   */
  evidence: ApplicationEvidenceView[];
}

export interface ApplicationSummary {
  planId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  /** The employer, when the vacancy carries a company. Null rather than guessed. */
  companyName: string | null;
  eligible: boolean;
  createdAt: string;
  attempts: ApplicationAttemptSummary[];
  /**
   * Mini-Phase 4: employer-side response stages, derived from the candidate's
   * own classified mail. Empty when no reply has been matched to this
   * application yet — which is the normal state, not an error.
   */
  responseCategories: ResponseCategory[];
}

interface ApplicationPlanRow {
  id: string;
  vacancy_id: string;
  gate_results: { eligible: boolean };
  created_at: string;
  vacancies: {
    raw_title: string;
    authoritative_url: string;
    companies: { displayed_name: string | null } | null;
  } | null;
  application_attempts: Array<{
    id: string;
    status: ApplicationAttemptStatus;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    // Reverse FK onto the attempt. Readable by the owner under RLS
    // (application_evidence_select_own); never written from the client.
    application_evidence: ApplicationEvidenceRow[] | null;
    // messages.application_attempt_id is a nullable FK onto the attempt, so
    // this embeds as a reverse relationship. A message can be captured before
    // matching happens, hence the nulls.
    messages: Array<{
      // PostgREST returns an array for every embed, even though the unique
      // index on message_id means response_classifications holds at most one
      // row here.
      response_classifications: Array<{ category: string }> | null;
    }> | null;
  }> | null;
}

/**
 * Employer-side response categories, collected from the candidate's own
 * classified mail.
 *
 * There is no "latest of several" to resolve: response_classifications carries
 * a unique index on message_id (20260828060000), so a message holds at most
 * ONE classification and re-classifying upserts that row rather than
 * appending. An earlier draft of this function sorted by classified_at for a
 * case the schema makes impossible; the unique index is the actual guarantee,
 * and deduplicating across messages is all that is left to do.
 *
 * category has no CHECK constraint — the taxonomy is code-owned in
 * server/mailbox/classifyMessage.ts — so an unrecognised value from a newer
 * taxonomy is dropped rather than surfaced as a stage the UI has no chip for.
 */
function collectResponseCategories(attempts: ApplicationPlanRow["application_attempts"]): ResponseCategory[] {
  const categories: ResponseCategory[] = [];

  for (const attempt of attempts ?? []) {
    for (const message of attempt.messages ?? []) {
      for (const classification of message.response_classifications ?? []) {
        if (isResponseCategory(classification.category) && !categories.includes(classification.category)) {
          categories.push(classification.category);
        }
      }
    }
  }

  return categories;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your applications. Please try again.";

export type ListApplicationsResult =
  | { kind: "success"; applications: ApplicationSummary[] }
  | { kind: "error"; message: string };

/**
 * Reads the caller's own application_plans, joined to vacancies (for
 * display) and application_attempts (for lifecycle status) via RLS —
 * application_plans_select_own and application_attempts_select_own already
 * scope both to auth.uid(), so this is a direct query, not a privileged
 * server route (see the resume_documents/candidate_exclusions precedent).
 * eligible is read straight off gate_results.eligible, the same
 * "derive, don't duplicate" source of truth applicationEngine.ts uses.
 */
export async function listApplications(
  client: Pick<SupabaseClient, "from">,
): Promise<ListApplicationsResult> {
  try {
    const { data, error } = await client
      .from("application_plans")
      // Three levels deep: plan -> attempts -> messages -> classifications.
      // Both hops are RLS-scoped to the caller (messages_select_own via
      // mailbox_connections.candidate_id, response_classifications_select_own
      // transitively through the same join), so this stays a direct
      // candidate-scoped read with no privileged route.
      .select(
        "id, vacancy_id, gate_results, created_at, vacancies (raw_title, authoritative_url, companies (displayed_name)), application_attempts (id, status, attempts, max_attempts, last_error, created_at, updated_at, application_evidence (id, evidence_type, payload, captured_at), messages (id, response_classifications (category, classified_at)))",
      )
      .order("created_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    const rows = data as unknown as ApplicationPlanRow[];

    return {
      kind: "success",
      applications: rows.map((row) => ({
        planId: row.id,
        vacancyId: row.vacancy_id,
        vacancyTitle: row.vacancies?.raw_title ?? "",
        vacancyUrl: row.vacancies?.authoritative_url ?? "",
        companyName: row.vacancies?.companies?.displayed_name ?? null,
        eligible: row.gate_results.eligible,
        createdAt: row.created_at,
        responseCategories: collectResponseCategories(row.application_attempts),
        attempts: (row.application_attempts ?? []).map((attempt) => ({
          id: attempt.id,
          status: attempt.status,
          attempts: attempt.attempts,
          maxAttempts: attempt.max_attempts,
          lastError: attempt.last_error,
          createdAt: attempt.created_at,
          updatedAt: attempt.updated_at,
          evidence: describeApplicationEvidence(attempt.application_evidence),
        })),
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
