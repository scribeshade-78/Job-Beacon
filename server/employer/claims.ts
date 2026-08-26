import type { SupabaseClient } from "@supabase/supabase-js";

export class CompanyNotFoundError extends Error {}

export interface SubmitEmployerClaimInput {
  userId: string;
  userEmail: string | null;
  companyId: string;
  representativeName: string;
  representativeRole: string;
  evidence?: string;
}

export interface SubmitEmployerClaimResult {
  id: string;
  domainVerified: boolean;
}

function emailDomain(email: string | null): string | null {
  if (!email) {
    return null;
  }

  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

/**
 * Upserts on (user_id, company_id) — R6.1's mailbox_connections precedent
 * for "reclaiming updates the one existing row" rather than leaving a
 * stale duplicate (e.g. resubmitting after a rejection with better
 * evidence).
 *
 * domainVerified is computed here — never client-supplied ("never trust
 * client-supplied... company verification") — by comparing the claiming
 * account's own verified email domain against companies.domain. Per
 * explicit product decision this is a signal a moderator sees, never an
 * auto-verification bypass: status is always ('pending') regardless of
 * the match, and only a moderator decision (submitEmployerClaimDecision)
 * ever sets 'verified'/'rejected'.
 */
export async function submitEmployerClaim(
  client: SupabaseClient,
  input: SubmitEmployerClaimInput,
): Promise<SubmitEmployerClaimResult> {
  const { data: company, error: companyError } = await client
    .from("companies")
    .select("domain")
    .eq("id", input.companyId)
    .maybeSingle();

  if (companyError) {
    throw companyError;
  }

  if (!company) {
    throw new CompanyNotFoundError(`No company found with id "${input.companyId}".`);
  }

  const companyRow = company as { domain: string | null };
  const accountDomain = emailDomain(input.userEmail);
  const domainVerified = Boolean(
    accountDomain && companyRow.domain && accountDomain === companyRow.domain.toLowerCase(),
  );

  const { data, error } = await client
    .from("employer_claims")
    .upsert(
      {
        user_id: input.userId,
        company_id: input.companyId,
        status: "pending",
        representative_name: input.representativeName,
        representative_role: input.representativeRole,
        evidence: input.evidence ?? null,
        domain_verified: domainVerified,
        verified_at: null,
        reverification_due_at: null,
      },
      { onConflict: "user_id,company_id" },
    )
    .select("id")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to insert employer_claims row — no row returned.");
  }

  return { id: (data as { id: string }).id, domainVerified };
}

export interface EmployerClaimQueueEntry {
  id: string;
  userId: string;
  companyId: string;
  companyName: string;
  representativeName: string;
  representativeRole: string;
  evidence: string | null;
  domainVerified: boolean;
  createdAt: string;
}

interface EmployerClaimQueueRow {
  id: string;
  user_id: string;
  company_id: string;
  representative_name: string;
  representative_role: string;
  evidence: string | null;
  domain_verified: boolean;
  created_at: string;
  companies: { displayed_name: string } | null;
}

/** Moderator-facing pending queue — service_role, since RLS scopes employer_claims to the claimant only (see requireEmployer.ts's own comment on why: no request-scoped RLS client exists for server routes). */
export async function getEmployerClaimsQueue(client: SupabaseClient): Promise<EmployerClaimQueueEntry[]> {
  const { data, error } = await client
    .from("employer_claims")
    .select(
      "id, user_id, company_id, representative_name, representative_role, evidence, domain_verified, created_at, companies (displayed_name)",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as EmployerClaimQueueRow[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    companyName: row.companies?.displayed_name ?? "",
    representativeName: row.representative_name,
    representativeRole: row.representative_role,
    evidence: row.evidence,
    domainVerified: row.domain_verified,
    createdAt: row.created_at,
  }));
}

export const EMPLOYER_CLAIM_DECISIONS = ["verified", "rejected"] as const;
export type EmployerClaimDecisionValue = (typeof EMPLOYER_CLAIM_DECISIONS)[number];

export interface SubmitEmployerClaimDecisionInput {
  claimId: string;
  reviewerId: string;
  decision: EmployerClaimDecisionValue;
  rationale: string;
}

const REVERIFICATION_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Two separate writes (decision row, then the employer_claims status
 * update), not a transaction — no RPC exists for this yet, same "two
 * separate writes, let it throw rather than swallow" shape reports.ts's
 * submitVacancyReport already uses and documents: if the second write
 * fails, this throws and the first write (the decision) stays durably
 * committed, a safe failure mode (the decision is recorded; a moderator
 * can retry the status flip), not a silently lost decision.
 */
export async function submitEmployerClaimDecision(
  client: SupabaseClient,
  input: SubmitEmployerClaimDecisionInput,
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("employer_claim_decisions")
    .insert({
      employer_claim_id: input.claimId,
      reviewer_id: input.reviewerId,
      decision: input.decision,
      rationale: input.rationale,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to insert employer_claim_decisions row — no row returned.");
  }

  const verifiedAt = new Date();

  const { error: updateError } = await client
    .from("employer_claims")
    .update({
      status: input.decision,
      verified_at: input.decision === "verified" ? verifiedAt.toISOString() : null,
      reverification_due_at:
        input.decision === "verified" ? new Date(verifiedAt.getTime() + REVERIFICATION_INTERVAL_MS).toISOString() : null,
    })
    .eq("id", input.claimId);

  if (updateError) {
    throw updateError;
  }

  return { id: (data as { id: string }).id };
}
