/**
 * Turns application_evidence rows into the small, safe summary a candidate sees.
 *
 * WHAT EVIDENCE IS. Each row is captured by the submission worker when something
 * actually happened to an attempt (server/applications/worker.ts) — a submission
 * that succeeded, a failure, or an exception that needs the candidate. RLS
 * already lets a candidate read their own rows (PRD §18.2 "Recent applications
 * and evidence"), so this module is not a permission boundary; it is a
 * DISCLOSURE boundary.
 *
 * WHY IT WHITELISTS RATHER THAN SPREADS. payload is deliberately generic JSONB,
 * written by adapters that put operational detail in it: the resolved endpoint,
 * the board/site identifiers, whether a stored or environment credential was
 * used, and — on the failure path — a raw exception message that may name an
 * internal host. None of that belongs in front of a candidate, and a field added
 * to an adapter payload later would otherwise appear here automatically. So every
 * displayed value is named explicitly below; an unrecognised field is dropped by
 * construction rather than by remembering to exclude it.
 *
 * ABSENCE IS NOT FAILURE. A plan with no attempts and an attempt with no evidence
 * are both ordinary states (nothing has been submitted yet), so an empty list is
 * returned as an empty list, never as an error.
 */

export type ApplicationEvidenceKind = "submission" | "action_required" | "failure" | "unknown";

export interface ApplicationEvidenceRow {
  id: string;
  evidence_type: string;
  payload: unknown;
  captured_at: string;
}

export interface ApplicationEvidenceView {
  id: string;
  kind: ApplicationEvidenceKind;
  /** Candidate-facing heading. */
  title: string;
  /** Safe, plain-language detail lines. Never raw payload values. */
  details: string[];
  capturedAt: string;
}

/**
 * Plain language for the exceptions that pause an application.
 *
 * Mirrors ACTION_REQUIRED_EXCEPTION_TYPES (server/applications/actionRequired.ts)
 * — a server/client split keeps the two lists from importing each other, so an
 * unrecognised type falls back to the generic sentence rather than printing the
 * raw token at a candidate.
 */
const EXCEPTION_COPY: Record<string, string> = {
  captcha: "The employer's form had a bot check that only a person can complete.",
  otp_or_email_code: "The employer sent a security code that only you can enter.",
  unknown_sensitive_question: "The form asked a question we couldn't answer from your confirmed details.",
  missing_verified_fact: "A detail the form requires is missing from your confirmed facts.",
  external_assessment: "The employer requires a separate assessment before applying.",
  unsupported_portal: "This employer's application system isn't supported yet.",
  payment_or_financial_request: "The form asked for payment details, so it was stopped.",
};

const GENERIC_ACTION_REQUIRED =
  "This application was paused and needs something from you before it can continue.";

/**
 * Plain language for a classified submission failure.
 *
 * The raw reasonCode stays in the database for support; a candidate gets the
 * sentence. An unknown code falls back to the generic failure line rather than
 * surfacing an internal identifier.
 */
const REASON_COPY: Record<string, string> = {
  MISSING_REQUIRED_CANDIDATE_FACT: "A required detail was missing from your confirmed facts.",
  NO_RESUME_DOCUMENT_FOR_CANDIDATE: "No resume was available to send.",
  MISSING_SUBMISSION_RESUME: "No resume was available to send.",
  GREENHOUSE_API_KEY_NOT_CONFIGURED: "Automatic submission isn't set up for this employer yet.",
  LEVER_CREDENTIAL_NOT_CONFIGURED: "Automatic submission isn't set up for this employer yet.",
  GREENHOUSE_TARGET_UNRESOLVABLE: "We couldn't identify the employer's application form for this job.",
  LEVER_TARGET_UNRESOLVABLE: "We couldn't identify the employer's application form for this job.",
  GREENHOUSE_SUBMISSION_REJECTED: "The employer's application system rejected the application.",
  LEVER_SUBMISSION_REJECTED: "The employer's application system rejected the application.",
};

const GENERIC_FAILURE = "This application could not be submitted.";

/** Reads one string field from the payload, or null. */
function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * The confirmation reference an adapter recorded, if any.
 *
 * greenhouse returns the employer's own application id; Lever returns a candidate
 * id. Both are the thing a support conversation would quote, and neither is a
 * secret.
 */
function confirmationReference(payload: Record<string, unknown>): string | null {
  for (const key of ["applicationId", "leverCandidateId", "confirmationMarker"]) {
    const value = payload[key];

    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function describeOne(row: ApplicationEvidenceRow): ApplicationEvidenceView {
  const payload = asRecord(row.payload);
  const base = { id: row.id, capturedAt: row.captured_at };

  if (row.evidence_type.endsWith("_submission") && row.evidence_type !== "submission_error") {
    const details: string[] = [];

    const reference = confirmationReference(payload);

    if (reference !== null) {
      details.push("Confirmation reference: " + reference);
    }

    const status = numberField(payload, "httpStatus");

    if (status !== null) {
      details.push("The employer's system accepted it (HTTP " + status + ").");
    }

    // The candidate's OWN filename. Safe, and it answers "which resume went?".
    const filename = stringField(payload, "resumeFilename");

    if (filename !== null) {
      details.push("Resume sent: " + filename);
    }

    return { ...base, kind: "submission", title: "Submitted to the employer", details };
  }

  if (row.evidence_type === "action_required") {
    const exceptionType = stringField(payload, "exceptionType");

    return {
      ...base,
      kind: "action_required",
      title: "Needs your input",
      details: [(exceptionType !== null && EXCEPTION_COPY[exceptionType]) || GENERIC_ACTION_REQUIRED],
    };
  }

  if (row.evidence_type === "submission_error") {
    const reasonCode = stringField(payload, "reasonCode");
    const details = [(reasonCode !== null && REASON_COPY[reasonCode]) || GENERIC_FAILURE];

    // Retryability is the one operational fact worth passing on, because it is
    // the difference between "wait" and "this needs you".
    if (payload.retryable === false) {
      details.push("This one won't be retried automatically.");
    } else if (payload.retryable === true) {
      details.push("We'll retry it automatically.");
    }

    return { ...base, kind: "failure", title: "Couldn't be submitted", details };
  }

  // An evidence type this build does not know about: say so plainly rather than
  // printing the token or silently hiding the row.
  return {
    ...base,
    kind: "unknown",
    title: "Application update",
    details: ["We recorded an update about this application."],
  };
}

export function describeApplicationEvidence(
  rows: readonly ApplicationEvidenceRow[] | null | undefined,
): ApplicationEvidenceView[] {
  if (!rows || rows.length === 0) {
    return [];
  }

  // Newest first, so the most recent thing that happened is the first thing read.
  return [...rows]
    .sort((a, b) => (a.captured_at < b.captured_at ? 1 : a.captured_at > b.captured_at ? -1 : 0))
    .map(describeOne);
}
