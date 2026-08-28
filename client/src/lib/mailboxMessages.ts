import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResponseClassificationEntry {
  id: string;
  category: string;
  confidence: number | null;
  modelVersion: string;
  classifiedAt: string;
  extractedCompany: string | null;
  extractedRole: string | null;
  extractedJobId: string | null;
  /** Postgres `date` — an ISO calendar day (YYYY-MM-DD) or null. */
  extractedDeadline: string | null;
  /** Verbatim salary phrasing from the message; never a computed figure. */
  extractedSalaryText: string | null;
}

export interface InterviewEntry {
  id: string;
  scheduledAt: string | null;
  format: string | null;
}

export const CANDIDATE_ACTION_ITEM_STATUSES = ["pending", "completed", "dismissed"] as const;

export type CandidateActionItemStatus = (typeof CANDIDATE_ACTION_ITEM_STATUSES)[number];

export interface CandidateActionItemEntry {
  id: string;
  itemType: string;
  status: CandidateActionItemStatus;
  dueAt: string | null;
}

export interface MailboxMessage {
  id: string;
  mailboxConnectionId: string;
  applicationAttemptId: string | null;
  providerMessageId: string;
  sender: string | null;
  subject: string | null;
  receivedAt: string | null;
  classifications: ResponseClassificationEntry[];
  interviews: InterviewEntry[];
  actionItems: CandidateActionItemEntry[];
}

interface MessageRow {
  id: string;
  mailbox_connection_id: string;
  application_attempt_id: string | null;
  provider_message_id: string;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  response_classifications: Array<{
    id: string;
    category: string;
    confidence: number | null;
    model_version: string;
    classified_at: string;
    extracted_company: string | null;
    extracted_role: string | null;
    extracted_job_id: string | null;
    extracted_deadline: string | null;
    extracted_salary_text: string | null;
  }> | null;
  interviews: Array<{
    id: string;
    scheduled_at: string | null;
    format: string | null;
  }> | null;
  candidate_action_items: Array<{
    id: string;
    item_type: string;
    status: CandidateActionItemStatus;
    due_at: string | null;
  }> | null;
}

const GENERIC_FAILURE_MESSAGE = "Could not load your mailbox messages. Please try again.";

export type ListMessagesResult =
  | { kind: "success"; messages: MailboxMessage[] }
  | { kind: "error"; message: string };

/**
 * Reads the caller's own messages via RLS (messages_select_own scopes
 * rows through mailbox_connections.candidate_id), joined to their
 * response_classifications/interviews/candidate_action_items — all
 * to-many (none of those three tables has a uniqueness constraint on
 * message_id, so more than one row per message is a real possibility,
 * e.g. a re-classification). One nested query rather than four flat
 * disconnected lists, same "join related data into one useful shape"
 * precedent as applications.ts embedding application_attempts under
 * application_plans.
 *
 * raw_payload is deliberately not selected on any of the four tables —
 * that column exists for internal/audit use (see each migration's own
 * comment on why no retention policy was invented for it yet), not as a
 * candidate-facing field.
 */
export async function listMessages(client: Pick<SupabaseClient, "from">): Promise<ListMessagesResult> {
  try {
    const { data, error } = await client
      .from("messages")
      .select(
        "id, mailbox_connection_id, application_attempt_id, provider_message_id, sender, subject, received_at, response_classifications (id, category, confidence, model_version, classified_at, extracted_company, extracted_role, extracted_job_id, extracted_deadline, extracted_salary_text), interviews (id, scheduled_at, format), candidate_action_items (id, item_type, status, due_at)",
      )
      .order("received_at", { ascending: false });

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    const rows = data as unknown as MessageRow[];

    return {
      kind: "success",
      messages: rows.map((row) => ({
        id: row.id,
        mailboxConnectionId: row.mailbox_connection_id,
        applicationAttemptId: row.application_attempt_id,
        providerMessageId: row.provider_message_id,
        sender: row.sender,
        subject: row.subject,
        receivedAt: row.received_at,
        classifications: (row.response_classifications ?? []).map((entry) => ({
          id: entry.id,
          category: entry.category,
          confidence: entry.confidence,
          modelVersion: entry.model_version,
          classifiedAt: entry.classified_at,
          extractedCompany: entry.extracted_company,
          extractedRole: entry.extracted_role,
          extractedJobId: entry.extracted_job_id,
          extractedDeadline: entry.extracted_deadline,
          extractedSalaryText: entry.extracted_salary_text,
        })),
        interviews: (row.interviews ?? []).map((entry) => ({
          id: entry.id,
          scheduledAt: entry.scheduled_at,
          format: entry.format,
        })),
        actionItems: (row.candidate_action_items ?? []).map((entry) => ({
          id: entry.id,
          itemType: entry.item_type,
          status: entry.status,
          dueAt: entry.due_at,
        })),
      })),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
