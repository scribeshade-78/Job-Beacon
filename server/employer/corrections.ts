import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * R5.4b's approved scalar allow-list (PRD §20.2 "correct objective company
 * facts with evidence"). Bakes the target table into the value itself
 * ('companies.domain', not a separate table_name column) — one column, no
 * invalid table+field combination is representable, and it's exactly what
 * the company_fact_corrections check constraint enforces at the DB layer
 * too (defense in depth, not duplicated validation for its own sake).
 */
export const CORRECTABLE_FIELDS = [
  "companies.displayed_name",
  "companies.domain",
  "companies.career_domain",
  "company_profiles.headquarters_country",
  "company_profiles.industry",
  "company_profiles.founded_year",
  "company_profiles.employee_size_range",
  "company_profiles.public_private_status",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export class InvalidFieldNameError extends Error {}
export class InvalidProposedValueError extends Error {}
export class UnverifiedEmployerError extends Error {}
export class CorrectionNotFoundError extends Error {}

interface FieldSpec {
  table: "companies" | "company_profiles";
  column: string;
  /** Text fields pass through as-is; founded_year must actually be an integer, checked here rather than deferred to a Postgres type-coercion error at apply time. */
  parse: (raw: string) => string | number;
}

function parseFoundedYear(raw: string): number {
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);

  if (!Number.isInteger(parsed) || String(parsed) !== trimmed) {
    throw new InvalidProposedValueError(`"${raw}" is not a valid integer for company_profiles.founded_year.`);
  }

  return parsed;
}

const FIELD_SPECS: Record<CorrectableField, FieldSpec> = {
  "companies.displayed_name": { table: "companies", column: "displayed_name", parse: (value) => value },
  "companies.domain": { table: "companies", column: "domain", parse: (value) => value },
  "companies.career_domain": { table: "companies", column: "career_domain", parse: (value) => value },
  "company_profiles.headquarters_country": { table: "company_profiles", column: "headquarters_country", parse: (value) => value },
  "company_profiles.industry": { table: "company_profiles", column: "industry", parse: (value) => value },
  "company_profiles.founded_year": { table: "company_profiles", column: "founded_year", parse: parseFoundedYear },
  "company_profiles.employee_size_range": { table: "company_profiles", column: "employee_size_range", parse: (value) => value },
  "company_profiles.public_private_status": { table: "company_profiles", column: "public_private_status", parse: (value) => value },
};

export function isCorrectableField(value: string): value is CorrectableField {
  return (CORRECTABLE_FIELDS as readonly string[]).includes(value);
}

export interface SubmitCompanyFactCorrectionInput {
  userId: string;
  companyId: string;
  fieldName: string;
  proposedValue: string;
  evidence?: string;
}

/**
 * requireEmployerOf already gates the route this is called from (verified
 * claim + AAL2), but the verified-claim lookup here isn't redundant with
 * that: it's how employer_claim_id (a required FK, never client-supplied)
 * gets resolved, and re-checking at the point of the actual write is the
 * same defense-in-depth discipline disconnectMailboxConnection already
 * uses for ownership. proposed_value is validated against the field's
 * real type here — fail fast at submission, not silently at moderator
 * approval time.
 */
export async function submitCompanyFactCorrection(
  client: SupabaseClient,
  input: SubmitCompanyFactCorrectionInput,
): Promise<{ id: string }> {
  if (!isCorrectableField(input.fieldName)) {
    throw new InvalidFieldNameError(`"${input.fieldName}" is not a correctable field.`);
  }

  FIELD_SPECS[input.fieldName].parse(input.proposedValue);

  const { data: claim, error: claimError } = await client
    .from("employer_claims")
    .select("id")
    .eq("user_id", input.userId)
    .eq("company_id", input.companyId)
    .eq("status", "verified")
    .maybeSingle();

  if (claimError) {
    throw claimError;
  }

  if (!claim) {
    throw new UnverifiedEmployerError("No verified employer claim found for this company.");
  }

  const { data, error } = await client
    .from("company_fact_corrections")
    .insert({
      employer_claim_id: (claim as { id: string }).id,
      company_id: input.companyId,
      field_name: input.fieldName,
      proposed_value: input.proposedValue,
      evidence: input.evidence ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to insert company_fact_corrections row — no row returned.");
  }

  return { id: (data as { id: string }).id };
}

export interface CompanyFactCorrectionQueueEntry {
  id: string;
  companyId: string;
  companyName: string;
  fieldName: CorrectableField;
  currentValue: string | null;
  proposedValue: string;
  evidence: string | null;
  createdAt: string;
}

interface CompanyFactCorrectionRow {
  id: string;
  company_id: string;
  field_name: CorrectableField;
  proposed_value: string;
  evidence: string | null;
  created_at: string;
  companies: { displayed_name: string } | null;
}

/**
 * Batched, not per-row: two extra queries (companies, company_profiles)
 * covering every distinct company represented in this page of the queue,
 * not one pair per correction — a company with several pending corrections
 * doesn't multiply the fetch count. currentValue is read live (not a
 * snapshot taken at submission time) — unlike vacancy evidence, which
 * moderation_cases freezes because ingestion can race ahead of review,
 * companies/company_profiles only change when an employer or admin
 * deliberately edits them, so there's no "consumed and gone" risk to guard
 * against by freezing it.
 */
export async function getCompanyFactCorrectionsQueue(client: SupabaseClient): Promise<CompanyFactCorrectionQueueEntry[]> {
  const { data, error } = await client
    .from("company_fact_corrections")
    .select("id, company_id, field_name, proposed_value, evidence, created_at, companies (displayed_name)")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as unknown as CompanyFactCorrectionRow[];
  const companyIds = [...new Set(rows.map((row) => row.company_id))];

  const { data: companiesRows, error: companiesError } = await client
    .from("companies")
    .select("id, displayed_name, domain, career_domain")
    .in("id", companyIds);

  if (companiesError) {
    throw companiesError;
  }

  const { data: profileRows, error: profilesError } = await client
    .from("company_profiles")
    .select("company_id, headquarters_country, industry, founded_year, employee_size_range, public_private_status")
    .in("company_id", companyIds);

  if (profilesError) {
    throw profilesError;
  }

  const companiesById = new Map(((companiesRows ?? []) as Array<Record<string, unknown>>).map((row) => [row.id, row]));
  const profilesById = new Map(
    ((profileRows ?? []) as Array<Record<string, unknown>>).map((row) => [row.company_id, row]),
  );

  return rows.map((row) => {
    const spec = FIELD_SPECS[row.field_name];
    const source = spec.table === "companies" ? companiesById.get(row.company_id) : profilesById.get(row.company_id);
    const currentValue = source?.[spec.column];

    return {
      id: row.id,
      companyId: row.company_id,
      companyName: row.companies?.displayed_name ?? "",
      fieldName: row.field_name,
      currentValue: currentValue === null || currentValue === undefined ? null : String(currentValue),
      proposedValue: row.proposed_value,
      evidence: row.evidence,
      createdAt: row.created_at,
    };
  });
}

export const CORRECTION_DECISIONS = ["approved", "rejected"] as const;
export type CorrectionDecisionValue = (typeof CORRECTION_DECISIONS)[number];

export interface SubmitCorrectionDecisionInput {
  correctionId: string;
  reviewerId: string;
  decision: CorrectionDecisionValue;
  rationale: string;
}

/**
 * Applies the data write BEFORE recording the decision — if the write
 * fails (a value that somehow slipped past submission-time validation),
 * the correction stays 'pending' rather than being marked 'approved' with
 * no actual effect. UPDATE for companies fields (the row always exists);
 * UPSERT for company_profiles fields (the 1:1 row is optional and may not
 * exist yet for every company — see its own migration).
 */
export async function submitCorrectionDecision(
  client: SupabaseClient,
  input: SubmitCorrectionDecisionInput,
): Promise<{ id: string }> {
  const { data: correction, error: fetchError } = await client
    .from("company_fact_corrections")
    .select("id, company_id, field_name, proposed_value")
    .eq("id", input.correctionId)
    .maybeSingle();

  if (fetchError) {
    throw fetchError;
  }

  if (!correction) {
    throw new CorrectionNotFoundError(`No company_fact_corrections row found with id "${input.correctionId}".`);
  }

  const row = correction as { id: string; company_id: string; field_name: CorrectableField; proposed_value: string };

  if (input.decision === "approved") {
    const spec = FIELD_SPECS[row.field_name];
    const value = spec.parse(row.proposed_value);

    if (spec.table === "companies") {
      const { error: updateError } = await client
        .from("companies")
        .update({ [spec.column]: value })
        .eq("id", row.company_id);

      if (updateError) {
        throw updateError;
      }
    } else {
      const { error: upsertError } = await client
        .from("company_profiles")
        .upsert({ company_id: row.company_id, [spec.column]: value }, { onConflict: "company_id" });

      if (upsertError) {
        throw upsertError;
      }
    }
  }

  const { error: decisionError } = await client
    .from("company_fact_corrections")
    .update({
      status: input.decision,
      reviewer_id: input.reviewerId,
      rationale: input.rationale,
      decided_at: new Date().toISOString(),
    })
    .eq("id", input.correctionId);

  if (decisionError) {
    throw decisionError;
  }

  return { id: row.id };
}
