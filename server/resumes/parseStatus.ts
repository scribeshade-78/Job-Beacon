/**
 * Resume parse-status transitions (Phase 0 Task 2).
 *
 * WHO WRITES THIS. Only the service-role extraction path, reached from
 * POST /api/resumes/:id/extract. A candidate holds no UPDATE grant on
 * resume_documents and (since the Task 2 migration) cannot INSERT parse_status,
 * so these transitions cannot be driven from the browser — which is what makes
 * 'parsed' trustworthy enough for readiness to depend on.
 *
 * WHY THE ERROR CODES ARE A CLOSED SET. parse_error is rendered to the
 * candidate, so it must never carry a stack trace, a storage path, a SQL
 * message or a provider response. Every failure is mapped to one of the codes
 * below before it is stored, which is a property of this module rather than of
 * each caller remembering to sanitize.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Safe, candidate-facing failure codes. */
export const RESUME_PARSE_ERRORS = [
  "unsupported_file_format",
  "unreadable_file",
  "extraction_service_failed",
  "unexpected_error",
] as const;

export type ResumeParseErrorCode = (typeof RESUME_PARSE_ERRORS)[number];

/**
 * Maps an extraction outcome to a safe code.
 *
 * 'not_found' is deliberately absent: an ownership mismatch must not write a
 * status at all, or the endpoint would let a caller change somebody else's
 * resume state by guessing an id.
 */
export function parseErrorCodeFor(kind: string): ResumeParseErrorCode | null {
  switch (kind) {
    case "unsupported_format":
      return "unsupported_file_format";
    case "malformed_extraction":
      return "extraction_service_failed";
    case "error":
      return "unexpected_error";
    default:
      return null;
  }
}

export interface ParseTransitionDeps {
  now?: () => Date;
}

/**
 * Marks a document as parsing, clearing any previous error.
 *
 * Retry is the same call: a document that failed or was never processed moves
 * straight to 'parsing' with the stale error removed, so a candidate retrying a
 * failed resume never sees the old failure while the new attempt is running.
 */
export async function markResumeParsing(
  client: SupabaseClient,
  resumeId: string,
  deps: ParseTransitionDeps = {},
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const { error } = await client
    .from("resume_documents")
    .update({
      parse_status: "parsing",
      parse_error: null,
      parse_started_at: now,
      parse_updated_at: now,
    })
    .eq("id", resumeId);

  if (error) {
    throw error;
  }
}

/** Marks a document as successfully parsed. parsed_at is required by the table's own constraint. */
export async function markResumeParsed(
  client: SupabaseClient,
  resumeId: string,
  deps: ParseTransitionDeps = {},
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const { error } = await client
    .from("resume_documents")
    .update({
      parse_status: "parsed",
      parse_error: null,
      parsed_at: now,
      parse_updated_at: now,
    })
    .eq("id", resumeId);

  if (error) {
    throw error;
  }
}

/** Marks a document as failed, storing only the safe code. */
export async function markResumeParseFailed(
  client: SupabaseClient,
  resumeId: string,
  code: ResumeParseErrorCode,
  deps: ParseTransitionDeps = {},
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();

  const { error } = await client
    .from("resume_documents")
    .update({
      parse_status: "failed",
      parse_error: code,
      parse_updated_at: now,
    })
    .eq("id", resumeId);

  if (error) {
    throw error;
  }
}
