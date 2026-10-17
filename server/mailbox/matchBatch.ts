import type { SupabaseClient } from "@supabase/supabase-js";
import { scoreApplicationMatch, type CandidateApplication, type MatchInput } from "./matchApplication.js";
import { readReplyTokenSecret, verifyReplyToken } from "./replyToken.js";

interface MessageRow {
  id: string;
  sender: string | null;
  /**
   * The receiving provider's raw Authentication-Results verdict, persisted at poll time
   * (see 20261019120000_messages_auth_results.sql). NULL means UNKNOWN, never passed.
   */
  auth_results: string | null;
  /**
   * The raw To header (falling back to Delivered-To), where the reply token arrives. NULL means
   * NOT CAPTURED — a message stored before the column existed, or a payload with neither header.
   */
  recipient: string | null;
  mailbox_connections: { candidate_id: string } | null;
  response_classifications: Array<{
    extracted_company: string | null;
    extracted_role: string | null;
    extracted_job_id: string | null;
  }> | null;
}

interface PlanRow {
  id: string;
  application_attempts: Array<{ id: string; created_at: string }> | null;
  vacancies: {
    raw_title: string | null;
    source_vacancy_id: string | null;
    companies: { displayed_name: string | null; domain: string | null; career_domain: string | null } | null;
  } | null;
}

export interface ClassifiedMessageEntities {
  extracted_company: string | null;
  extracted_role: string | null;
  extracted_job_id: string | null;
}

export type SingleMessageLinkOutcome =
  | { kind: "auto"; attemptId: string; confidence: number; reasons: string[]; linked: boolean }
  | { kind: "review"; candidates: unknown[] }
  | { kind: "ambiguous"; candidates: unknown[] }
  | { kind: "none" };

/**
 * Scores one classified message against one candidate's applications and, on a
 * confident match, writes the link.
 *
 * Extracted so the batch below and server/integrations/emailParser.ts share ONE
 * implementation of "what a link is". The write is three fields on the message
 * (application_attempt_id plus the application_match evidence) and it is the
 * only mutation either path performs — there is no attempt or plan status to
 * update, because the candidate-visible stage is derived from this link. See
 * emailParser.ts for why that matters.
 *
 * The update is guarded with .is("application_attempt_id", null) so a
 * concurrent or repeated pass cannot overwrite an existing link with a
 * different one.
 */
export interface MatchMessageContext {
  id: string;
  sender: string | null;
  /** Raw To/Delivered-To header — where a reply token arrives. Absent means NOT CAPTURED. */
  recipient?: string | null;
  authResults?: string | null;
}

/**
 * The reply-token secret, or null when this deployment has not configured one.
 *
 * NOT A HARD FAILURE. Matching must keep working on a deployment that never minted a token, and
 * a token can only have been minted where this same secret was configured. If the secret has
 * since been removed, the result is the pre-token behaviour: every reply falls back to the
 * heuristics, the same way it does when a provider strips the `+`.
 */
function optionalReplyTokenSecret(env: Record<string, string | undefined> = process.env): Buffer | null {
  try {
    return readReplyTokenSecret(env);
  } catch {
    return null;
  }
}

export async function matchOneClassifiedMessage(
  client: SupabaseClient,
  message: MatchMessageContext,
  classification: ClassifiedMessageEntities,
  apps: CandidateApplication[],
  options: { replyTokenSecret?: Buffer | null } = {},
): Promise<SingleMessageLinkOutcome> {
  const replyTokenSecret =
    options.replyTokenSecret === undefined ? optionalReplyTokenSecret() : options.replyTokenSecret;

  // Verified against THIS candidate's attempts only, which is how ownership is enforced without
  // a second query: a token minted for somebody else's attempt simply resolves to nothing.
  const verified =
    message.recipient && replyTokenSecret
      ? verifyReplyToken(
          message.recipient,
          apps.map((app) => app.attemptId),
          replyTokenSecret,
        )
      : null;

  const input: MatchInput = {
    sender: message.sender,
    company: classification.extracted_company,
    role: classification.extracted_role,
    jobId: classification.extracted_job_id,
    // Absent for a caller that has no provider verdict (the raw .eml ingest path) — that is
    // UNKNOWN, and authVerdict only ever acts on an explicit failure.
    authResults: message.authResults,
    // Null means no usable token, which is NOT the same as a failed verification: both fall
    // through to the heuristics.
    verifiedAttemptId: verified?.attemptId ?? null,
  };

  const match = scoreApplicationMatch(input, apps);

  if (match.kind !== "auto") {
    return match;
  }

  const { data: updated, error } = await client
    .from("messages")
    .update({
      application_attempt_id: match.attemptId,
      application_match: {
        confidence: match.confidence,
        reasons: match.reasons,
        matched_at: new Date().toISOString(),
      },
    })
    .eq("id", message.id)
    .is("application_attempt_id", null)
    .select("id");

  if (error) {
    throw error;
  }

  return {
    kind: "auto",
    attemptId: match.attemptId,
    confidence: match.confidence,
    reasons: match.reasons,
    // A zero-row update means something linked it first; the link is real
    // either way, so this reports whether THIS call was the one that wrote it.
    linked: (updated ?? []).length > 0,
  };
}

export interface RunApplicationMatchBatchResult {
  scanned: number;
  linked: number;
  review: number;
  ambiguous: number;
  unmatched: number;
  errors: number;
}

/**
 * One CandidateApplication per application_plan, using that plan's most
 * recent attempt as the link target. A plan can have several attempts
 * (retries) that all share the same vacancy — feeding every attempt to the
 * scorer would make identical scores and force a permanent "ambiguous"
 * verdict, so they collapse to the newest attempt here.
 */
export async function loadCandidateApplications(
  client: SupabaseClient,
  candidateId: string,
): Promise<CandidateApplication[]> {
  const { data, error } = await client
    .from("application_plans")
    .select(
      "id, application_attempts (id, created_at), vacancies (raw_title, source_vacancy_id, companies (displayed_name, domain, career_domain))",
    )
    .eq("candidate_id", candidateId);

  if (error) {
    throw error;
  }

  const apps: CandidateApplication[] = [];

  for (const plan of (data ?? []) as unknown as PlanRow[]) {
    const attempts = plan.application_attempts ?? [];
    if (attempts.length === 0) {
      continue;
    }
    const latest = [...attempts].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0]!;
    const company = plan.vacancies?.companies ?? null;
    apps.push({
      attemptId: latest.id,
      companyName: company?.displayed_name ?? null,
      companyDomain: company?.domain ?? null,
      careerDomain: company?.career_domain ?? null,
      roleTitle: plan.vacancies?.raw_title ?? null,
      sourceVacancyId: plan.vacancies?.source_vacancy_id ?? null,
    });
  }

  return apps;
}

/**
 * Sweeps `messages` that are classified but not yet linked to an
 * application and tries to link each to one of the owning candidate's own
 * application attempts. Standalone (not inline in classification): a
 * recruiter email often lands before the candidate's application_plan
 * exists in JobBeacon, so this is re-run and picks up still-NULL messages
 * on a later pass. Idempotent — only touches rows where
 * application_attempt_id IS NULL. Never throws per message.
 *
 * ponytail: the 0.60-0.84 "review" band and ambiguous verdicts are only
 * structured-logged, not persisted — a review-queue table is the upgrade
 * if manual triage becomes a real workflow.
 */
export async function runApplicationMatchBatch(
  client: SupabaseClient,
  options: { limit?: number; replyTokenSecret?: Buffer | null } = {},
): Promise<RunApplicationMatchBatchResult> {
  const limit = options.limit ?? 50;
  // Resolved ONCE per batch: reading the environment per message would let one run behave
  // differently from the next if the variable changed mid-flight.
  const replyTokenSecret =
    options.replyTokenSecret === undefined ? optionalReplyTokenSecret() : options.replyTokenSecret;

  const { data, error } = await client
    .from("messages")
    .select(
      "id, sender, auth_results, recipient, mailbox_connections!inner (candidate_id), response_classifications!inner (extracted_company, extracted_role, extracted_job_id)",
    )
    .is("application_attempt_id", null)
    .order("received_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as unknown as MessageRow[];
  const appCache = new Map<string, CandidateApplication[]>();
  const result: RunApplicationMatchBatchResult = {
    scanned: rows.length,
    linked: 0,
    review: 0,
    ambiguous: 0,
    unmatched: 0,
    errors: 0,
  };

  for (const row of rows) {
    try {
      const candidateId = row.mailbox_connections?.candidate_id;
      const classification = row.response_classifications?.[0];
      if (!candidateId || !classification) {
        result.unmatched += 1;
        continue;
      }

      let apps = appCache.get(candidateId);
      if (!apps) {
        apps = await loadCandidateApplications(client, candidateId);
        appCache.set(candidateId, apps);
      }

      const match = await matchOneClassifiedMessage(
        client,
        {
          id: row.id,
          sender: row.sender,
          recipient: row.recipient,
          authResults: row.auth_results,
        },
        classification,
        apps,
        { replyTokenSecret },
      );

      if (match.kind === "auto") {
        result.linked += 1;
      } else if (match.kind === "review") {
        result.review += 1;
        console.warn("[mailbox:match] review", { messageId: row.id, candidates: match.candidates });
      } else if (match.kind === "ambiguous") {
        result.ambiguous += 1;
        console.warn("[mailbox:match] ambiguous", { messageId: row.id, candidates: match.candidates });
      } else {
        result.unmatched += 1;
      }
    } catch (caught) {
      result.errors += 1;
      console.error("[mailbox:match] error processing message", {
        messageId: row.id,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  return result;
}
