import type { SupabaseClient } from "@supabase/supabase-js";
import { computeContentHash, computeFingerprint } from "./fingerprint.js";
import type { DiscoveredVacancy } from "./types.js";

type IngestClient = Pick<SupabaseClient, "from">;

export type IngestOutcome = "created" | "updated" | "unchanged" | "merged_as_source_record";

export interface IngestResult {
  vacancyId: string;
  outcome: IngestOutcome;
}

async function getOrCreateCompany(
  client: IngestClient,
  displayedName: string,
  domain: string | null,
): Promise<string> {
  const { data: existing } = await client
    .from("companies")
    .select("id")
    .eq("displayed_name", displayedName)
    .maybeSingle();

  if (existing) {
    return existing.id;
  }

  // ON CONFLICT DO NOTHING + re-select handles the race where another
  // ingestion run inserts the same company between the check above and
  // this insert (companies.displayed_name is unique — see its migration).
  const { data: inserted, error } = await client
    .from("companies")
    .upsert({ displayed_name: displayedName, domain }, { onConflict: "displayed_name", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();

  if (inserted) {
    return inserted.id;
  }

  if (error) {
    throw error;
  }

  const { data: afterRace, error: afterRaceError } = await client
    .from("companies")
    .select("id")
    .eq("displayed_name", displayedName)
    .single();

  if (afterRaceError || !afterRace) {
    throw afterRaceError ?? new Error(`Could not resolve company "${displayedName}" after upsert race.`);
  }

  return afterRace.id;
}

/**
 * Applies dedup rules 1 and 2 (§11.3) and writes one discovered vacancy:
 * exact (source_code, source_vacancy_id) match updates the existing
 * vacancy; a match on authoritative_url via a *different* source_vacancy_id
 * merges it as an additional vacancy_source_records row rather than
 * creating a duplicate vacancy; otherwise a new canonical vacancy is
 * created. Idempotent — safe to call again with the same input.
 */
export async function ingestDiscoveredVacancy(
  client: IngestClient,
  sourceCode: string,
  vacancySourceId: string,
  discovered: DiscoveredVacancy,
): Promise<IngestResult> {
  const nowIso = new Date().toISOString();
  const contentHash = computeContentHash(discovered.raw);
  const fingerprint = computeFingerprint(discovered);

  const { data: existingBySource } = await client
    .from("vacancies")
    .select("id")
    .eq("source_code", sourceCode)
    .eq("source_vacancy_id", discovered.sourceVacancyId)
    .maybeSingle();

  if (existingBySource) {
    const vacancyId = existingBySource.id as string;

    await client
      .from("vacancies")
      .update({
        // Kept fresh on every re-fetch, not just at creation — if this
        // job's URL genuinely changes upstream (e.g. a slug rename) and
        // the update below hits vacancies' unique index on
        // authoritative_url, that's a real conflict, not something to
        // paper over: it surfaces as an error through ingestDiscoveredVacancy's
        // caller (the worker's try/catch), which logs and retries it,
        // rather than silently leaving the stale URL in place forever.
        authoritative_url: discovered.authoritativeUrl,
        raw_title: discovered.rawTitle,
        country: discovered.country,
        region: discovered.region,
        city: discovered.city,
        remote_type: discovered.remoteType,
        currency: discovered.currency,
        salary_min: discovered.salaryMin,
        salary_max: discovered.salaryMax,
        salary_interval: discovered.salaryInterval,
        salary_source: discovered.salarySource,
        published_at: discovered.publishedAt,
        last_seen_at: nowIso,
        status: "active",
        updated_at: nowIso,
      })
      .eq("id", vacancyId);

    await client
      .from("vacancy_source_records")
      .update({ authoritative_url: discovered.authoritativeUrl, last_seen_at: nowIso })
      .eq("source_code", sourceCode)
      .eq("source_vacancy_id", discovered.sourceVacancyId);

    await client
      .from("vacancy_fingerprints")
      .upsert({ vacancy_id: vacancyId, fingerprint }, { onConflict: "vacancy_id" });

    const { data: latestVersion } = await client
      .from("vacancy_versions")
      .select("content_hash")
      .eq("vacancy_id", vacancyId)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestVersion?.content_hash === contentHash) {
      return { vacancyId, outcome: "unchanged" };
    }

    await client
      .from("vacancy_versions")
      .insert({ vacancy_id: vacancyId, raw_payload: discovered.raw, content_hash: contentHash });

    return { vacancyId, outcome: "updated" };
  }

  const { data: existingByUrl } = await client
    .from("vacancies")
    .select("id")
    .eq("authoritative_url", discovered.authoritativeUrl)
    .maybeSingle();

  if (existingByUrl) {
    const vacancyId = existingByUrl.id as string;

    await client.from("vacancy_source_records").upsert(
      {
        vacancy_id: vacancyId,
        source_code: sourceCode,
        source_vacancy_id: discovered.sourceVacancyId,
        authoritative_url: discovered.authoritativeUrl,
        last_seen_at: nowIso,
      },
      { onConflict: "source_code,source_vacancy_id" },
    );

    return { vacancyId, outcome: "merged_as_source_record" };
  }

  const companyId = await getOrCreateCompany(client, discovered.companyName, discovered.companyDomain);

  const { data: created, error: createError } = await client
    .from("vacancies")
    .insert({
      source_code: sourceCode,
      vacancy_source_id: vacancySourceId,
      source_vacancy_id: discovered.sourceVacancyId,
      authoritative_url: discovered.authoritativeUrl,
      raw_title: discovered.rawTitle,
      company_id: companyId,
      country: discovered.country,
      region: discovered.region,
      city: discovered.city,
      remote_type: discovered.remoteType,
      currency: discovered.currency,
      salary_min: discovered.salaryMin,
      salary_max: discovered.salaryMax,
      salary_interval: discovered.salaryInterval,
      salary_source: discovered.salarySource,
      published_at: discovered.publishedAt,
    })
    .select("id")
    .single();

  if (createError || !created) {
    throw createError ?? new Error("Failed to create vacancy — no row returned.");
  }

  const vacancyId = created.id as string;

  await client
    .from("vacancy_versions")
    .insert({ vacancy_id: vacancyId, raw_payload: discovered.raw, content_hash: contentHash });

  await client.from("vacancy_source_records").insert({
    vacancy_id: vacancyId,
    source_code: sourceCode,
    source_vacancy_id: discovered.sourceVacancyId,
    authoritative_url: discovered.authoritativeUrl,
  });

  await client.from("vacancy_fingerprints").insert({ vacancy_id: vacancyId, fingerprint });

  return { vacancyId, outcome: "created" };
}

/**
 * Freshness (§11.1 step 21): after a target's discovery run, any of its
 * still-'active' vacancies not seen in this run are marked 'expired'.
 * Scoped to vacancy_source_id specifically (not the whole source_code) —
 * see the vacancies migration for why that column exists.
 */
export async function markUnseenVacanciesExpired(
  client: Pick<SupabaseClient, "from">,
  vacancySourceId: string,
  seenVacancyIds: string[],
): Promise<void> {
  let query = client
    .from("vacancies")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("vacancy_source_id", vacancySourceId)
    .eq("status", "active");

  if (seenVacancyIds.length > 0) {
    query = query.not("id", "in", `(${seenVacancyIds.join(",")})`);
  }

  await query;
}
