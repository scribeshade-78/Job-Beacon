import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { detectPromptInjection } from "../security/sanitize.js";
import { recordSecurityEvent } from "../security/events.js";
import {
  classifyMessageContent,
  DEFAULT_CLASSIFICATION_MODEL,
  MalformedClassificationError,
  MESSAGE_CLASSIFICATION_PROMPT_VERSION,
  type MessageCategory,
  type MessageClassificationInput,
} from "./classifyMessage.js";

function resolveModel(model?: string): string {
  return model ?? process.env.OPENAI_MODEL ?? process.env.OPENROUTER_MODEL ?? DEFAULT_CLASSIFICATION_MODEL;
}

export interface ClassifiableMessage extends MessageClassificationInput {
  /** messages.id (uuid) — the FK target of response_classifications.message_id. */
  messageId: string;
}

export type ClassifyMessageResult =
  | { kind: "classified"; category: MessageCategory }
  | { kind: "malformed"; message: string }
  | { kind: "error"; message: string };

/**
 * Classifies one message and upserts its response_classifications row.
 * Never throws — the poll hook calls this best-effort, and the batch below
 * must keep going after a single bad message. The upsert is keyed on
 * message_id (unique index from 20260828060000), so a re-run — poll retry,
 * backfill batch, prompt-version bump — replaces the row rather than
 * duplicating it. On malformed model output nothing is written, same
 * "reject, never partial-insert" rule as resume extraction.
 */
export async function classifyAndStoreMessage(
  serviceClient: SupabaseClient,
  openaiClient: Pick<OpenAI, "chat">,
  message: ClassifiableMessage,
  model?: string,
): Promise<ClassifyMessageResult> {
  const resolvedModel = resolveModel(model);

  // Task H4, RI PRD §10.3. Detection runs HERE, at the boundary that has a
  // database client, while the sanitization that protects the prompt happens in
  // classifyMessage.ts's renderMessage. Both read the same text; splitting them
  // this way keeps the prompt builder pure and testable while still making a
  // detection a queryable security event rather than a log line.
  //
  // Recorded before classification, not after: an injection attempt is worth
  // knowing about even when the model call that follows fails, and a detection
  // that only survived a successful classification would be the least likely to
  // be recorded exactly when something is going wrong.
  if (message.bodyText) {
    const findings = detectPromptInjection(message.bodyText);
    if (findings.length > 0) {
      await recordSecurityEvent(serviceClient, {
        eventType: findings[0]!.type,
        // A request to disclose a secret or to act is treated as HIGH; the rest
        // are MEDIUM. Nothing here is LOW, because every pattern this list
        // matches is a shape with no ordinary reason to appear in recruiting
        // mail — if that stops being true, the pattern is wrong, not the level.
        severity:
          findings.some(
            (finding) =>
              finding.type === "secret_disclosure_request" ||
              finding.type === "unauthorised_action_request",
          )
            ? "high"
            : "medium",
        source: "email_body",
        subjectId: message.messageId,
        detail: { findings },
      });
    }
  }

  let classification;

  try {
    classification = await classifyMessageContent(
      openaiClient,
      { sender: message.sender, subject: message.subject, bodyText: message.bodyText },
      resolvedModel,
    );
  } catch (error) {
    if (error instanceof MalformedClassificationError) {
      return { kind: "malformed", message: error.message };
    }
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const { error: upsertError } = await serviceClient.from("response_classifications").upsert(
    {
      message_id: message.messageId,
      category: classification.category,
      confidence: classification.confidence,
      model_version: resolvedModel,
      prompt_version: MESSAGE_CLASSIFICATION_PROMPT_VERSION,
      extracted_company: classification.company,
      extracted_role: classification.role,
      extracted_job_id: classification.job_id,
      extracted_deadline: classification.deadline,
      extracted_salary_text: classification.salary_text,
      raw_extraction: classification,
    },
    { onConflict: "message_id" },
  );

  if (upsertError) {
    return { kind: "error", message: upsertError.message };
  }

  return { kind: "classified", category: classification.category };
}

export interface RunMessageClassificationBatchResult {
  scanned: number;
  classified: number;
  malformed: number;
  errors: number;
}

interface UnclassifiedMessageRow {
  id: string;
  sender: string | null;
  subject: string | null;
  raw_payload: { snippet?: unknown } | null;
}

/**
 * Backfill / retry pass: classifies `messages` rows that have no
 * response_classifications row yet — messages stored before this feature
 * existed, or ones whose inline classification during poll failed
 * (OpenRouter down, rate-limited).
 *
 * ponytail: this path classifies from the stored sender + subject +
 * Gmail snippet only — it does NOT re-fetch the full body from Gmail (that
 * would need per-connection OAuth token refresh here). Fresh mail is
 * classified with the full plain-text body inline during poll
 * (poll.ts -> fetchMessagePlainText); this is the lighter safety net.
 * Add per-connection token resolution + fetchMessagePlainText here if
 * backfill entity-extraction quality turns out to matter.
 */
export async function runMessageClassificationBatch(
  serviceClient: SupabaseClient,
  openaiClient: Pick<OpenAI, "chat">,
  options: { limit?: number } = {},
  model?: string,
): Promise<RunMessageClassificationBatchResult> {
  const limit = options.limit ?? 25;

  const { data, error } = await serviceClient
    .from("messages")
    .select("id, sender, subject, raw_payload, response_classifications!left(message_id)")
    .is("response_classifications", null)
    .order("received_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as UnclassifiedMessageRow[];

  let classified = 0;
  let malformed = 0;
  let errors = 0;

  for (const row of rows) {
    const snippet = typeof row.raw_payload?.snippet === "string" ? row.raw_payload.snippet : null;

    const result = await classifyAndStoreMessage(
      serviceClient,
      openaiClient,
      { messageId: row.id, sender: row.sender, subject: row.subject, bodyText: snippet },
      model,
    );

    if (result.kind === "classified") {
      classified += 1;
    } else if (result.kind === "malformed") {
      malformed += 1;
    } else {
      errors += 1;
    }
  }

  return { scanned: rows.length, classified, malformed, errors };
}
