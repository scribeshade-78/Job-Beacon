import type { SupabaseClient } from "@supabase/supabase-js";
import type { McaCompanyRecord } from "./mcaRegistry.js";

export interface RegistryIngestResult {
  registryRecordId: string;
  legalEntityId: string;
}

/**
 * Records raw registry evidence and upserts the derived legal-entity
 * fact for one company — two writes, not one transaction, matching
 * server/ingestion/ingest.ts's own precedent for this class of
 * multi-write operation (a torn write here leaves evidence recorded
 * without a legal-entity update, a safe, visible partial state, not a
 * silently lost one).
 *
 * jurisdiction/capital_currency are hardcoded to 'IN'/'INR' — mcaRegistry.ts
 * only ever queries the India MCA registry today. A second registry
 * source (Companies House, SEC) would need its own record type and its
 * own jurisdiction/currency passed through, not a copy of this function
 * with different literals.
 *
 * The upsert's ON CONFLICT target is (company_id, jurisdiction,
 * registry_identifier) — the unique constraint added specifically for
 * this pipeline (R5.6 migration), since R5.4's original schema had none.
 */
export async function recordAndUpsertLegalEntity(
  client: SupabaseClient,
  companyId: string,
  record: McaCompanyRecord,
): Promise<RegistryIngestResult> {
  const { data: registryRecord, error: registryError } = await client
    .from("company_registry_records")
    .insert({
      company_id: companyId,
      registry_source: "mca_india",
      raw_payload: record.raw,
    })
    .select("id")
    .single();

  if (registryError || !registryRecord) {
    throw registryError ?? new Error("Failed to insert company_registry_records row.");
  }

  const { data: legalEntity, error: legalEntityError } = await client
    .from("company_legal_entities")
    .upsert(
      {
        company_id: companyId,
        jurisdiction: "IN",
        registry_identifier: record.cin,
        legal_name: record.legalName,
        registration_status: record.registrationStatus,
        registration_date: record.registrationDate,
        company_category: record.companyCategory,
        company_class: record.companyClass,
        authorized_capital: record.authorizedCapital,
        paid_up_capital: record.paidUpCapital,
        capital_currency: "INR",
        registered_region: record.registeredRegion,
        registrar: record.registrar,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id,jurisdiction,registry_identifier" },
    )
    .select("id")
    .single();

  if (legalEntityError || !legalEntity) {
    throw legalEntityError ?? new Error("Failed to upsert company_legal_entities row.");
  }

  return {
    registryRecordId: (registryRecord as { id: string }).id,
    legalEntityId: (legalEntity as { id: string }).id,
  };
}
