import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchFollowUp, type FollowUpDispatchResult } from "./followUpDispatch.js";
import { FollowUpDraftMissingSubjectError, OutboundMailNotConfiguredError } from "./followUpErrors.js";
import type { MailTransport } from "./mailTransport.js";
import { readReplyTokenSecret } from "./replyToken.js";
import { createResendTransport, readResendConfig } from "./resendTransport.js";

/**
 * Task C2 — the candidate-facing review surface for follow-up drafts.
 *
 * WHY THIS IS A SERVER MODULE RATHER THAN A BROWSER READ. The list could be
 * read directly under RLS — follow_up_drafts_select_own already scopes rows to
 * the owning candidate — and the panel's other section does exactly that. But
 * the two ACTIONS cannot be: approving sets a status the candidate's own role
 * has no UPDATE grant for, and that is deliberate. A status this product treats
 * as "approved for sending" must not be writable by the browser that displays
 * it, or the transition is a client-side claim. Keeping the read beside the
 * writes means all three agree about what a draft is by construction.
 *
 * NO OWNERSHIP IS ASSUMED FROM THE ID. follow_up_drafts has no candidate_id and
 * ownership is two hops away (draft -> attempt -> plan -> candidate_id), so
 * every entry point resolves it explicitly. Same shape as attemptReview.ts, and
 * the same 404-not-403 answer for both "no such draft" and "not yours".
 */

export class FollowUpDraftNotFoundError extends Error {
  constructor(public readonly draftId: string) {
    super(`No follow_up_drafts row exists for id ${draftId}`);
    this.name = "FollowUpDraftNotFoundError";
  }
}

export class FollowUpDraftNotOwnedError extends Error {
  constructor(public readonly draftId: string) {
    super(`Follow-up draft ${draftId} does not belong to this candidate`);
    this.name = "FollowUpDraftNotOwnedError";
  }
}

/** The draft is not awaiting review, so this action is not meaningful on it. */
export class FollowUpDraftNotPendingError extends Error {
  constructor(public readonly draftId: string, public readonly status: string) {
    super(`Follow-up draft ${draftId} is "${status}", not "pending_review".`);
    this.name = "FollowUpDraftNotPendingError";
  }
}

export interface PendingFollowUp {
  draftId: string;
  applicationAttemptId: string;
  /** Null when the vacancy has no company row — the fixture and aggregator postings often do not. */
  companyName: string | null;
  vacancyTitle: string;
  vacancyUrl: string;
  daysSinceSubmission: number;
  submittedAt: string;
  draftText: string;
  generatedAt: string;
  modelVersion: string;
  promptVersion: string;
}

interface DraftRow {
  id: string;
  application_attempt_id: string;
  draft_text: string;
  generated_at: string;
  model_version: string;
  prompt_version: string;
  application_attempts: {
    succeeded_at: string | null;
    application_plans: {
      candidate_id: string;
      vacancies: { raw_title: string; authoritative_url: string; companies: { displayed_name: string } | null } | null;
    } | null;
  } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days between submission and now, floored.
 *
 * Computed here rather than read from find_ghosted_attempts, which computes the
 * same thing for the DETECTOR's window. The two are intentionally separate: the
 * detector's number decides eligibility at draft time, this one is what the
 * candidate reads today, and a draft can sit in the queue for days. Reusing the
 * stored age would show a stale number on exactly the applications that have
 * waited longest.
 */
function daysSince(submittedAt: string | null, now: number): number {
  if (!submittedAt) {
    return 0;
  }

  const submitted = Date.parse(submittedAt);

  if (!Number.isFinite(submitted)) {
    return 0;
  }

  return Math.max(0, Math.floor((now - submitted) / DAY_MS));
}

/**
 * candidate_id is selected through the join specifically so ownership can be
 * decided from the same row, rather than by a second query per draft.
 */
const PENDING_SELECT =
  "id, application_attempt_id, draft_text, generated_at, model_version, prompt_version, " +
  "application_attempts (succeeded_at, application_plans (candidate_id, vacancies (raw_title, authoritative_url, companies (displayed_name))))";

/**
 * Every draft awaiting this candidate's review, oldest first.
 *
 * Ordered by submission date rather than by when the draft was written: the
 * application that has waited longest is the one worth showing first, and the
 * draft order is an artefact of whichever sweep ran.
 */
export async function listPendingFollowUps(
  client: SupabaseClient,
  candidateId: string,
  options: { now?: number } = {},
): Promise<PendingFollowUp[]> {
  const { data, error } = await client
    .from("follow_up_drafts")
    .select(PENDING_SELECT)
    .eq("status", "pending_review");

  if (error) {
    throw error;
  }

  const now = options.now ?? Date.now();
  const rows = (data ?? []) as unknown as DraftRow[];

  const pending: PendingFollowUp[] = [];

  for (const row of rows) {
    const plan = row.application_attempts?.application_plans;
    const vacancy = plan?.vacancies;

    // Ownership is decided here, not by the query: follow_up_drafts has no
    // candidate_id, so it cannot be filtered on directly, and the service-role
    // client bypasses the RLS policy that would otherwise scope it. This
    // comparison IS the boundary — not a second check behind one.
    if (plan?.candidate_id !== candidateId) {
      continue;
    }

    pending.push({
      draftId: row.id,
      applicationAttemptId: row.application_attempt_id,
      companyName: vacancy?.companies?.displayed_name ?? null,
      vacancyTitle: vacancy?.raw_title ?? "(vacancy removed)",
      vacancyUrl: vacancy?.authoritative_url ?? "",
      daysSinceSubmission: daysSince(row.application_attempts?.succeeded_at ?? null, now),
      submittedAt: row.application_attempts?.succeeded_at ?? "",
      draftText: row.draft_text,
      generatedAt: row.generated_at,
      modelVersion: row.model_version,
      promptVersion: row.prompt_version,
    });
  }

  // Ascending: the longest-waiting application first.
  return pending.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
}

interface OwnedDraft {
  draftId: string;
  status: string;
  applicationAttemptId: string;
  vacancyTitle: string;
  companyName: string | null;
  draftText: string;
  /** NULL on drafts written before the subject existed: not approvable, not silently defaulted. */
  subject: string | null;
  sendAttempts: number;
}

/**
 * Loads a draft and proves the caller owns it, via the two-hop join.
 */
export async function loadOwnedDraft(
  client: SupabaseClient,
  candidateId: string,
  draftId: string,
): Promise<OwnedDraft> {
  const { data: draft, error: draftError } = await client
    .from("follow_up_drafts")
    .select(
      `id, status, subject, send_attempts, application_attempt_id, draft_text, application_attempts (application_plan_id)`,
    )
    .eq("id", draftId)
    .maybeSingle();

  if (draftError) {
    throw draftError;
  }
  if (!draft) {
    throw new FollowUpDraftNotFoundError(draftId);
  }

  const row = draft as unknown as {
    id: string;
    status: string;
    subject: string | null;
    send_attempts: number;
    application_attempt_id: string;
    draft_text: string;
    application_attempts: { application_plan_id: string } | null;
  };

  const planId = row.application_attempts?.application_plan_id;

  if (!planId) {
    throw new FollowUpDraftNotFoundError(draftId);
  }

  const { data: plan, error: planError } = await client
    .from("application_plans")
    .select("candidate_id, vacancies (raw_title, companies (displayed_name))")
    .eq("id", planId)
    .maybeSingle();

  if (planError) {
    throw planError;
  }
  if (!plan) {
    throw new FollowUpDraftNotFoundError(draftId);
  }

  const planRow = plan as unknown as {
    candidate_id: string;
    vacancies: { raw_title: string; companies: { displayed_name: string } | null } | null;
  };

  if (planRow.candidate_id !== candidateId) {
    throw new FollowUpDraftNotOwnedError(draftId);
  }

  return {
    draftId: row.id,
    status: row.status,
    applicationAttemptId: row.application_attempt_id,
    vacancyTitle: planRow.vacancies?.raw_title ?? "(vacancy removed)",
    companyName: planRow.vacancies?.companies?.displayed_name ?? null,
    draftText: row.draft_text,
    subject: row.subject,
    sendAttempts: row.send_attempts,
  };
}

export interface FollowUpActionDeps {
  /** Injected in tests so the dispatch line can be asserted without capturing stdout. */
  logDispatch?: (line: string, detail: Record<string, unknown>) => void;
}

export interface SendFollowUpDeps extends FollowUpActionDeps {
  /** Injected by tests; the real dispatcher otherwise. */
  dispatch?: typeof dispatchFollowUp;
  transport?: MailTransport;
  from?: { name: string | null; address: string };
  replyTokenSecret?: Buffer;
  now?: () => number;
}

export interface SendFollowUpResult {
  draftId: string;
  status: "sent";
  /** TRUE now means the provider ACCEPTED it. The previous phase typed this literal false. */
  transmitted: true;
  providerMessageId: string;
  recipient: string;
  note: string;
}

/**
 * Resolves the provider configuration lazily.
 *
 * A MISSING CONFIG IS A DEPLOYMENT STATE, NOT A SEND FAILURE. Wrapping it in its own error lets
 * the route answer 503 "not configured yet" instead of a generic 500 that reads like the
 * candidate's draft is broken.
 */
function resolveOutboundMail(): { transport: MailTransport; from: { name: string | null; address: string } } {
  try {
    const config = readResendConfig();
    return { transport: createResendTransport({ apiKey: config.apiKey }), from: config.from };
  } catch (error) {
    throw new OutboundMailNotConfiguredError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Sends one approved follow-up.
 *
 * The preconditions the REVIEW layer owns — ownership, still pending, has a subject — are checked
 * here, before anything external happens. Everything after that (consent, recipient, claim,
 * delivery, settlement) belongs to dispatchFollowUp, the module that reasons about irreversibility.
 */
export async function sendFollowUpDraft(
  client: SupabaseClient,
  candidateId: string,
  draftId: string,
  deps: SendFollowUpDeps = {},
): Promise<SendFollowUpResult> {
  const draft = await loadOwnedDraft(client, candidateId, draftId);

  if (draft.status !== "pending_review") {
    throw new FollowUpDraftNotPendingError(draftId, draft.status);
  }

  if (draft.subject === null || draft.subject.trim() === "") {
    // Drafted before the subject existed. The candidate has nothing to approve yet, and an
    // invented subject is not theirs to sign off on.
    throw new FollowUpDraftMissingSubjectError(draftId);
  }

  const mail =
    deps.transport && deps.from ? { transport: deps.transport, from: deps.from } : resolveOutboundMail();
  const replyTokenSecret = deps.replyTokenSecret ?? readReplyTokenSecret();
  const dispatch = deps.dispatch ?? dispatchFollowUp;
  const logDispatch = deps.logDispatch ?? ((line, detail) => console.log(line, detail));

  const sent: FollowUpDispatchResult = await dispatch(
    client,
    {
      draftId: draft.draftId,
      candidateId,
      applicationAttemptId: draft.applicationAttemptId,
      subject: draft.subject,
      text: draft.draftText,
      sendAttempts: draft.sendAttempts,
    },
    {
      transport: mail.transport,
      from: mail.from,
      replyTokenSecret,
      now: deps.now,
      log: (event, detail) => logDispatch(event, detail ?? {}),
    },
  );

  logDispatch("[follow-up:dispatch] sent", {
    draftId,
    providerMessageId: sent.providerMessageId,
    to: sent.recipient,
  });

  return {
    draftId,
    status: "sent",
    transmitted: true,
    providerMessageId: sent.providerMessageId,
    recipient: sent.recipient,
    note: "Sent to " + sent.recipient + ".",
  };
}

export interface DismissFollowUpResult {
  draftId: string;
  status: "dismissed";
}

/**
 * Dismisses a draft. The detector already refuses to draft again for an attempt
 * that has one, so this is a permanent "no" for that application rather than a
 * snooze — which is why it is not offered as "later".
 */
export async function dismissFollowUpDraft(
  client: SupabaseClient,
  candidateId: string,
  draftId: string,
): Promise<DismissFollowUpResult> {
  const draft = await loadOwnedDraft(client, candidateId, draftId);

  if (draft.status !== "pending_review") {
    throw new FollowUpDraftNotPendingError(draftId, draft.status);
  }

  const { data: updated, error } = await client
    .from("follow_up_drafts")
    .update({ status: "dismissed", updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("status", "pending_review")
    .select("id");

  if (error) {
    throw error;
  }

  if (!updated || updated.length === 0) {
    throw new FollowUpDraftNotPendingError(draftId, "changed");
  }

  return { draftId, status: "dismissed" };
}
