import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { classifyAndStoreMessage } from "../mailbox/classifyBatch.js";
import {
  loadCandidateApplications,
  matchOneClassifiedMessage,
  type ClassifiedMessageEntities,
} from "../mailbox/matchBatch.js";
import { MESSAGE_CATEGORIES, type MessageCategory } from "../mailbox/classifyMessage.js";
import {
  countByPipelineStage,
  pipelineStageOf,
  type CategorizedPipelineStageId,
} from "../../shared/pipelineStages.js";

/**
 * Task Z — the email feedback loop, without a mailbox.
 *
 * WHAT THIS IS FOR. The rest of the response pipeline (server/mailbox/) is
 * built around a real Gmail connection: OAuth, token refresh, a poller, a
 * classification batch, a matching batch. That machinery is exercised end to
 * end by its own suites, but it cannot be demonstrated at all in an environment
 * with no connected mailbox — which is this one, and which is why the
 * candidate's Responses page has nothing on it. This module lets a raw email
 * payload go through the SAME pipeline and produce the SAME rows, so the loop
 * can be observed and tested.
 *
 * ---------------------------------------------------------------------------
 * THE STATE TRANSITION, AND WHY THIS MODULE DOES NOT WRITE A STATUS COLUMN
 *
 * This task asked for the matched application_attempts row (or its
 * application_plans parent) to have its status updated to the real-world
 * outcome. This module deliberately does NOT do that, and the reason is
 * architectural rather than a shortcut:
 *
 *   1. application_plans has NO status column, on purpose. Its migration
 *      records the reasoning: "blocked vs eligible is derived from
 *      gateResults.eligible... Adding a redundant status column here would
 *      create a second, driftable source of truth."
 *
 *   2. application_attempts.status means something narrower than "outcome".
 *      shared/pipelineStages.ts states the guardrail explicitly: "Rejection
 *      NEVER maps to application_attempts.status = failed. That value means the
 *      submission worker could not send the application at all... Rendering it
 *      as a rejection would tell a candidate they were turned down for a job
 *      that was never applied to." Writing 'rejected' or 'interviewing' into
 *      that column would need new values and would break that meaning.
 *
 *   3. The candidate-visible stage is ALREADY derived, from exactly the rows
 *      this module writes. pipelineStageOf reads the application's linked
 *      messages' classifications and resolves offer > rejection > interview,
 *      falling back to Applied when a submission succeeded. The moment a
 *      rejection email is linked to an attempt, the application moves to
 *      Rejection — with no status column involved, and with no way for a stored
 *      status and a linked email to disagree about the same application.
 *
 * So the transition this module performs IS the state transition: it links the
 * message. That is what the rest of the system reads, and storing it again
 * would mean keeping two answers to one question. The stageAfter field on the
 * result below is read BACK from the same derivation the UI uses, so the caller
 * can see the candidate-facing effect rather than take it on trust.
 * ---------------------------------------------------------------------------
 */

/** The provider value these messages are filed under. Never polled — see 20260917230000. */
export const LOCAL_PAYLOAD_PROVIDER = "local_payload";

export interface ParsedEmail {
  providerMessageId: string;
  sender: string | null;
  subject: string | null;
  bodyText: string;
  receivedAt: string | null;
  /** True when no id was supplied and one was derived from the payload's content. */
  idDerived: boolean;
}

export class UnparseableEmailError extends Error {
  constructor(detail: string) {
    super(`Could not read the supplied email payload: ${detail}`);
    this.name = "UnparseableEmailError";
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A stable id for a payload that does not carry one.
 *
 * Content-addressed rather than random: the same payload ingested twice must
 * collide on the messages unique index over (mailbox_connection_id,
 * provider_message_id) so a re-run is a no-op instead of a duplicate email on
 * the candidate's Responses page. Hashing the whole payload rather than, say,
 * sender plus subject keeps two genuinely different emails that share a subject
 * from collapsing into one.
 */
function derivedMessageId(payload: string): string {
  return `local-${createHash("sha256").update(payload).digest("hex").slice(0, 32)}`;
}

/**
 * Reads a payload in either of the two shapes this utility accepts.
 *
 *   * an object — the shape a Gmail API fetch or a webhook would hand over.
 *     Field aliases are accepted (from/sender, body/text/bodyText,
 *     date/receivedAt) because there is no single canonical spelling across
 *     providers, and a caller should not have to reshape a real payload to get
 *     it ingested.
 *   * a raw string — RFC822-ish "Header: value" lines, a blank line, then the
 *     body. Enough to paste an actual email in without wrapping it in JSON.
 *
 * A payload with neither a body nor a subject is rejected rather than stored: a
 * message row that says nothing cannot be classified, and classifying it anyway
 * would spend a model call to produce a category of "other".
 */
export function parseRawEmailPayload(raw: unknown): ParsedEmail {
  if (typeof raw === "string") {
    return parseRfc822ish(raw);
  }

  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const bodyText =
      asNonEmptyString(record.bodyText) ?? asNonEmptyString(record.body) ?? asNonEmptyString(record.text) ?? "";
    const subject = asNonEmptyString(record.subject);

    if (!bodyText && !subject) {
      throw new UnparseableEmailError("the object has neither a subject nor a body");
    }

    const suppliedId =
      asNonEmptyString(record.providerMessageId) ??
      asNonEmptyString(record.messageId) ??
      asNonEmptyString(record.id);

    return {
      providerMessageId: suppliedId ?? derivedMessageId(JSON.stringify(raw)),
      sender: asNonEmptyString(record.sender) ?? asNonEmptyString(record.from),
      subject,
      bodyText,
      receivedAt:
        asNonEmptyString(record.receivedAt) ??
        asNonEmptyString(record.received_at) ??
        asNonEmptyString(record.date),
      idDerived: suppliedId === null,
    };
  }

  throw new UnparseableEmailError(`expected an object or a string, received ${typeof raw}`);
}

const HEADER_PATTERN = /^(from|sender|subject|date|received|message-id):\s*(.*)$/i;

function parseRfc822ish(raw: string): ParsedEmail {
  const normalized = raw.replace(/\r\n/g, "\n");
  const [head = "", ...rest] = normalized.split("\n\n");
  const bodyText = rest.join("\n\n").trim();

  const headers: Record<string, string> = {};
  const headLines = head.split("\n");
  let currentKey: string | null = null;

  for (const line of headLines) {
    const match = line.match(HEADER_PATTERN);
    if (match) {
      currentKey = match[1]!.toLowerCase();
      headers[currentKey] = match[2]!.trim();
      continue;
    }
    // Continuation line (RFC 822 folding) — append to the header above it.
    if (currentKey && /^\s+/.test(line)) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`.trim();
    }
  }

  const subject = asNonEmptyString(headers.subject);
  const looksLikeHeaders = Object.keys(headers).length > 0;

  // With no recognisable headers the whole string is the body — someone pasting
  // just the message text is the common case, and rejecting it for lacking a
  // From: line would be pedantry.
  const resolvedBody = looksLikeHeaders ? bodyText : normalized.trim();

  if (!resolvedBody && !subject) {
    throw new UnparseableEmailError("the text has neither a subject nor a body");
  }

  const suppliedId = asNonEmptyString(headers["message-id"]);

  return {
    providerMessageId: suppliedId ?? derivedMessageId(normalized),
    sender: asNonEmptyString(headers.from) ?? asNonEmptyString(headers.sender),
    subject,
    bodyText: resolvedBody,
    receivedAt: asNonEmptyString(headers.date) ?? asNonEmptyString(headers.received),
    idDerived: suppliedId === null,
  };
}

export interface IngestEmailResult {
  messageId: string;
  providerMessageId: string;
  /** True when this exact payload had already been ingested and linked. */
  duplicate: boolean;
  classification: {
    category: MessageCategory;
    confidence: number | null;
    company: string | null;
    role: string | null;
    jobId: string | null;
    deadline: string | null;
    salaryText: string | null;
  };
  match: {
    kind: "auto" | "review" | "ambiguous" | "none";
    attemptId: string | null;
    confidence: number | null;
    reasons: string[];
  };
  /**
   * The stage the matched application now sits in, computed by the same
   * function the UI uses (shared/pipelineStages.ts) from the database after the
   * link was written. This is the observable state transition.
   */
  stageAfter: CategorizedPipelineStageId | null;
}

/**
 * Resolves the connection local payloads are filed under, creating it on first
 * use. One per candidate, enforced by the existing (candidate_id, provider)
 * unique constraint rather than by this code.
 */
async function getOrCreateLocalConnection(client: SupabaseClient, candidateId: string): Promise<string> {
  const { data: existing, error: readError } = await client
    .from("mailbox_connections")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("provider", LOCAL_PAYLOAD_PROVIDER)
    .maybeSingle();

  if (readError) throw readError;
  if (existing) return (existing as { id: string }).id;

  const { data: inserted, error: insertError } = await client
    .from("mailbox_connections")
    .upsert(
      {
        candidate_id: candidateId,
        provider: LOCAL_PAYLOAD_PROVIDER,
        status: "connected",
        // Deliberately null, and deliberately not a Gmail address: nothing here
        // should read as a connected inbox.
        email_address: null,
      },
      { onConflict: "candidate_id,provider", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();

  if (insertError) throw insertError;
  if (inserted) return (inserted as { id: string }).id;

  // Lost a race with another ingest; re-read the winner.
  const { data: afterRace, error: afterError } = await client
    .from("mailbox_connections")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("provider", LOCAL_PAYLOAD_PROVIDER)
    .single();

  if (afterError || !afterRace) {
    throw afterError ?? new Error("Could not resolve the local payload connection after an upsert race.");
  }

  return (afterRace as { id: string }).id;
}

/**
 * Reads the matched application's stage back out of the database, using the
 * same derivation the Applications page renders.
 */
async function readStageForAttempt(
  client: SupabaseClient,
  attemptId: string,
): Promise<CategorizedPipelineStageId | null> {
  const { data: attempt, error } = await client
    .from("application_attempts")
    .select("id, status, application_plan_id")
    .eq("id", attemptId)
    .maybeSingle();

  if (error) throw error;
  if (!attempt) return null;

  const planId = (attempt as { application_plan_id: string }).application_plan_id;

  const { data: attempts, error: attemptsError } = await client
    .from("application_attempts")
    .select("id, status, application_plans (gate_results), messages (id, response_classifications (category))")
    .eq("application_plan_id", planId);

  if (attemptsError) throw attemptsError;

  const rows = (attempts ?? []) as unknown as Array<{
    status: string;
    // Embedded parent row: gate_results.eligible is what separates "In
    // Progress" from "Not eligible" in the shared stage rule.
    application_plans: { gate_results: { eligible?: boolean } | null } | null;
    messages: Array<{ response_classifications: Array<{ category: string }> | null }> | null;
  }>;

  const categories: string[] = [];

  for (const row of rows) {
    for (const message of row.messages ?? []) {
      for (const classification of message.response_classifications ?? []) {
        if (!categories.includes(classification.category)) {
          categories.push(classification.category);
        }
      }
    }
  }

  return pipelineStageOf({
    attempts: rows.map((row) => ({ status: row.status })),
    responseCategories: categories,
    // Fail closed: a plan row we cannot read is treated as not-eligible, the
    // same default the MCP pipeline summary uses.
    eligible: rows[0]?.application_plans?.gate_results?.eligible ?? false,
  });
}

export interface IngestEmailDeps {
  /** Injected in tests so the model is never called. */
  classify?: typeof classifyAndStoreMessage;
}

/**
 * Ingests one raw email payload for one candidate: parse, store, classify,
 * match, link — the same steps the mailbox pipeline performs, in the same
 * order, writing the same rows.
 *
 * Ordering matters and mirrors poll.ts: the message is stored FIRST and
 * classified second, so a model failure leaves a real (unclassified) message
 * that the backfill batch can pick up, rather than losing the email entirely.
 */
export async function ingestEmailResponse(
  client: SupabaseClient,
  openai: Pick<OpenAI, "chat">,
  input: { candidateId: string; raw: unknown; model?: string },
  deps: IngestEmailDeps = {},
): Promise<IngestEmailResult> {
  const parsed = parseRawEmailPayload(input.raw);
  const connectionId = await getOrCreateLocalConnection(client, input.candidateId);

  // Upserts on (mailbox_connection_id, provider_message_id): re-ingesting the
  // same payload returns the existing row instead of adding a second copy.
  const { data: stored, error: storeError } = await client
    .from("messages")
    .upsert(
      {
        mailbox_connection_id: connectionId,
        provider_message_id: parsed.providerMessageId,
        sender: parsed.sender,
        subject: parsed.subject,
        received_at: parsed.receivedAt ?? new Date().toISOString(),
        raw_payload: { ingestedFrom: LOCAL_PAYLOAD_PROVIDER, parsed, raw: input.raw },
      },
      { onConflict: "mailbox_connection_id,provider_message_id" },
    )
    .select("id, application_attempt_id")
    .single();

  if (storeError || !stored) {
    throw storeError ?? new Error("Storing the message returned no row.");
  }

  const messageId = (stored as { id: string }).id;
  const alreadyLinked = (stored as { application_attempt_id: string | null }).application_attempt_id;

  // Skip the paid call when this message already carries a classification —
  // the same guard poll.ts uses on its overlapping window.
  const { data: existingClassification } = await client
    .from("response_classifications")
    .select("id")
    .eq("message_id", messageId)
    .maybeSingle();

  const classify = deps.classify ?? classifyAndStoreMessage;

  if (!existingClassification) {
    await classify(
      client,
      openai,
      { messageId, sender: parsed.sender, subject: parsed.subject, bodyText: parsed.bodyText },
      input.model,
    );
  }

  const { data: classificationRow, error: classificationError } = await client
    .from("response_classifications")
    .select(
      "category, confidence, extracted_company, extracted_role, extracted_job_id, extracted_deadline, extracted_salary_text",
    )
    .eq("message_id", messageId)
    .single();

  if (classificationError || !classificationRow) {
    throw classificationError ?? new Error("The message has no classification to read back.");
  }

  const row = classificationRow as {
    category: string;
    confidence: number | null;
    extracted_company: string | null;
    extracted_role: string | null;
    extracted_job_id: string | null;
    extracted_deadline: string | null;
    extracted_salary_text: string | null;
  };

  const entities: ClassifiedMessageEntities = {
    extracted_company: row.extracted_company,
    extracted_role: row.extracted_role,
    extracted_job_id: row.extracted_job_id,
  };

  let match: IngestEmailResult["match"] = { kind: "none", attemptId: null, confidence: null, reasons: [] };

  if (alreadyLinked) {
    match = { kind: "auto", attemptId: alreadyLinked, confidence: null, reasons: ["already_linked"] };
  } else {
    const apps = await loadCandidateApplications(client, input.candidateId);
    const outcome = await matchOneClassifiedMessage(
      client,
      { id: messageId, sender: parsed.sender },
      entities,
      apps,
    );

    match =
      outcome.kind === "auto"
        ? { kind: "auto", attemptId: outcome.attemptId, confidence: outcome.confidence, reasons: outcome.reasons }
        : { kind: outcome.kind, attemptId: null, confidence: null, reasons: [] };
  }

  return {
    messageId,
    providerMessageId: parsed.providerMessageId,
    duplicate: existingClassification !== null && alreadyLinked !== null,
    classification: {
      category: (MESSAGE_CATEGORIES as readonly string[]).includes(row.category)
        ? (row.category as MessageCategory)
        : "other",
      confidence: row.confidence,
      company: row.extracted_company,
      role: row.extracted_role,
      jobId: row.extracted_job_id,
      deadline: row.extracted_deadline,
      salaryText: row.extracted_salary_text,
    },
    match,
    stageAfter: match.attemptId ? await readStageForAttempt(client, match.attemptId) : null,
  };
}

export { countByPipelineStage };
