import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConfirmationStatus } from "./factConfirmations";

export interface ExtractedFact {
  id: string;
  sourceDocumentId: string;
  factType: string;
  factValue: string;
  createdAt: string;
  /** fact_confirmations.status — "pending" if MP-F2's extraction-time insert somehow didn't happen for this row (defensive default, not expected in practice). */
  confirmationStatus: ConfirmationStatus;
  /** null = confirmed exactly as extracted; non-null = the candidate edited it. Always null while pending/rejected. */
  correctedValue: string | null;
}

const GENERIC_LIST_FAILURE_MESSAGE = "Could not load extracted facts. Please try again.";

export type ListExtractedFactsResult =
  | { kind: "success"; facts: ExtractedFact[] }
  | { kind: "error"; message: string };

/**
 * extracted_facts RLS already scopes SELECT to the signed-in candidate's
 * own rows (extracted_facts_select_own) — this is a direct browser->Supabase
 * read, same as listResumes, not routed through Express. Fetches every fact
 * for the candidate (not filtered by resume) so the panel can group by
 * sourceDocumentId itself without an extra round trip per resume.
 *
 * Two-step query (facts, then confirmations for those fact ids) mirrors the
 * same shape eligibilityGate.ts's evaluateVerifiedFacts and
 * resumeGenerator.ts's generateResumePayload already use server-side.
 */
export async function listExtractedFacts(client: Pick<SupabaseClient, "from">): Promise<ListExtractedFactsResult> {
  try {
    const { data, error } = await client
      .from("extracted_facts")
      .select("id, source_document_id, fact_type, fact_value, created_at")
      .order("created_at", { ascending: true });

    if (error || !data) {
      return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
    }

    const factIds = data.map((row) => row.id);

    const { data: confirmationRows, error: confirmationError } =
      factIds.length === 0
        ? { data: [] as Array<{ extracted_fact_id: string; status: ConfirmationStatus; corrected_value: string | null }>, error: null }
        : await client
            .from("fact_confirmations")
            .select("extracted_fact_id, status, corrected_value")
            .in("extracted_fact_id", factIds);

    if (confirmationError) {
      return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
    }

    const confirmationByFactId = new Map(
      (confirmationRows ?? []).map((row) => [row.extracted_fact_id, row]),
    );

    return {
      kind: "success",
      facts: data.map((row) => {
        const confirmation = confirmationByFactId.get(row.id);
        return {
          id: row.id,
          sourceDocumentId: row.source_document_id,
          factType: row.fact_type,
          factValue: row.fact_value,
          createdAt: row.created_at,
          confirmationStatus: confirmation?.status ?? "pending",
          correctedValue: confirmation?.corrected_value ?? null,
        };
      }),
    };
  } catch {
    return { kind: "error", message: GENERIC_LIST_FAILURE_MESSAGE };
  }
}

export interface ExtractedFactSummary {
  id: string;
  factType: string;
  factValue: string;
}

export type ExtractResumeFactsResult =
  | { kind: "success"; facts: ExtractedFactSummary[] }
  | { kind: "error"; message: string };

const GENERIC_EXTRACT_FAILURE_MESSAGE = "Could not extract facts from this resume. Please try again.";

/**
 * Calls the server-side extraction endpoint — this one can't be a direct
 * Supabase call like listExtractedFacts: inserting into extracted_facts
 * requires the service-role client (extracted_facts grants INSERT only to
 * service_role, per its migration), and the extraction itself needs a
 * server-held OPENAI_API_KEY. Same injectable-fetchImpl shape as
 * fetchVerifiedIdentity in auth.ts.
 */
export async function extractResumeFacts(
  resumeId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractResumeFactsResult> {
  let response: Response;

  try {
    response = await fetchImpl(`/api/resumes/${resumeId}/extract`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_EXTRACT_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return { kind: "error", message };
  }

  try {
    const body = (await response.json()) as { facts: ExtractedFactSummary[] };
    return { kind: "success", facts: body.facts };
  } catch {
    return { kind: "error", message: GENERIC_EXTRACT_FAILURE_MESSAGE };
  }
}
