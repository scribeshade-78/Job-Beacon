import type { SupabaseClient } from "@supabase/supabase-js";
import { listOpportunitiesByIds, type OpportunitySummary } from "./opportunities";

/**
 * One listing: the card's summary, the captured job description and the
 * employer's verified company context.
 *
 * WHY THIS IS A SECOND AND THIRD READ. candidate_opportunities (the view the
 * Opportunities panel already reads) deliberately exposes fit and plan columns
 * but NOT the description body or the company's profile — the card never showed
 * either. The full text and its section boundaries live on
 * vacancy_jd_snapshots, which authenticated users can SELECT (RLS policy
 * vacancy_jd_snapshots_select_all, 20260831120000), and the company profile on
 * company_profiles, which is granted SELECT to authenticated too
 * (20260820090000). So the summary is read through the existing data source and
 * the detail through existing tables, and no new schema or server route is
 * introduced.
 */

/** One detected JD heading and the body that follows it (vacancy_jd_snapshots.sections). */
export interface JobSection {
  heading: string | null;
  body: string;
}

export interface JobDescription {
  /** vacancy_jd_snapshots.clean_text — the full cleaned posting text. */
  cleanText: string;
  /** vacancy_jd_snapshots.sections — [{ heading, body }], possibly empty. */
  sections: JobSection[];
  /** vacancy_jd_snapshots.captured_at — when this text was captured from the source. */
  capturedAt: string | null;
}

/**
 * The employer's verified facts. Every field is independently nullable: a
 * company can have a row with only some columns filled, and the page renders
 * the gaps as "Not provided by source" rather than omitting the section.
 */
export interface CompanyContext {
  name: string | null;
  domain: string | null;
  industry: string | null;
  headquartersCountry: string | null;
  operatingCountries: string[];
  employeeSizeRange: string | null;
  foundedYear: number | null;
  publicPrivateStatus: string | null;
}

export type LoadJobDetailResult =
  | {
      kind: "success";
      job: OpportunitySummary;
      description: JobDescription | null;
      company: CompanyContext | null;
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

const FAILURE_MESSAGE = "Could not load this job. Please try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates the jsonb sections array.
 *
 * DELIBERATELY STRICT AND DELIBERATELY NOT THROWING. sections is raw jsonb, so
 * a shape this build does not recognise must degrade to "no structured
 * sections" — the page then falls back to clean_text — rather than crashing the
 * route or rendering an entry whose body is not a string.
 */
export function parseJobSections(value: unknown): JobSection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sections: JobSection[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const body = entry.body;

    if (body !== undefined && typeof body !== "string") {
      continue;
    }

    sections.push({
      heading: stringOrNull(entry.heading),
      body: typeof body === "string" ? body : "",
    });
  }

  return sections;
}

/**
 * Reads the employer's verified context by the listing's company domain.
 *
 * BY DOMAIN, NOT BY ID, because candidate_opportunities exposes company_name
 * and company_domain but not company_id: adding the id would mean redefining
 * the view (a migration) for one read. Domain is the identity stub companies
 * was built around (20260813205324) and companyIntelligence already treats it
 * as the company's key, so this reads the same pairing through the same tables.
 *
 * A MISSING DOMAIN OR MISSING PROFILE IS NOT AN ERROR — it is the honest
 * "we have no verified company facts for this listing", which the page renders
 * as such.
 */
async function loadCompanyContext(
  client: Pick<SupabaseClient, "from">,
  companyDomain: string | null,
): Promise<CompanyContext | null> {
  if (companyDomain === null) {
    return null;
  }

  try {
    const { data, error } = await client
      .from("companies")
      .select(
        "displayed_name, domain, company_profiles (headquarters_country, operating_countries, industry, founded_year, employee_size_range, public_private_status)",
      )
      .eq("domain", companyDomain)
      .limit(1)
      .maybeSingle();

    if (error || !isRecord(data)) {
      return null;
    }

    // A 1:1 embed resolves to an object in PostgREST, but an array is accepted
    // here so a future to-many shape cannot silently blank the whole section.
    const rawProfile = data.company_profiles;
    const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;

    if (!isRecord(profile)) {
      // The company row exists but has no verified profile: still worth showing
      // the name/domain the listing already carries.
      return {
        name: stringOrNull(data.displayed_name),
        domain: stringOrNull(data.domain),
        industry: null,
        headquartersCountry: null,
        operatingCountries: [],
        employeeSizeRange: null,
        foundedYear: null,
        publicPrivateStatus: null,
      };
    }

    const countries = Array.isArray(profile.operating_countries)
      ? profile.operating_countries.filter((entry): entry is string => typeof entry === "string")
      : [];

    return {
      name: stringOrNull(data.displayed_name),
      domain: stringOrNull(data.domain),
      industry: stringOrNull(profile.industry),
      headquartersCountry: stringOrNull(profile.headquarters_country),
      operatingCountries: countries,
      employeeSizeRange: stringOrNull(profile.employee_size_range),
      foundedYear: typeof profile.founded_year === "number" ? profile.founded_year : null,
      publicPrivateStatus: stringOrNull(profile.public_private_status),
    };
  } catch {
    return null;
  }
}

/**
 * Reads one listing by id, then its latest JD snapshot and company context.
 *
 * A missing snapshot is NOT an error: some sources ship no usable JD text and
 * the fit worker records that as jd_text_available = false. The page says so
 * rather than inventing a description.
 */
export async function loadJobDetail(
  client: Pick<SupabaseClient, "from">,
  jobId: string,
): Promise<LoadJobDetailResult> {
  try {
    const result = await listOpportunitiesByIds(client, [jobId]);

    if (result.kind === "error") {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const job = result.opportunities[0];

    // The view applies its own trust/active filter, so an id that exists but is
    // FLAGGED/BLOCKED/expired reads as not found here — the same set the list
    // can show.
    if (!job) {
      return { kind: "not_found" };
    }

    // The same "latest snapshot for the vacancy" read interviewPrep.ts uses:
    // ordered by created_at desc, at most one row considered.
    const { data, error } = await client
      .from("vacancy_jd_snapshots")
      .select("clean_text, sections, captured_at")
      .eq("vacancy_id", jobId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return { kind: "error", message: FAILURE_MESSAGE };
    }

    const row = isRecord(data) ? data : null;
    const cleanText = row ? (stringOrNull(row.clean_text) ?? "") : "";

    const description: JobDescription | null =
      row === null || (cleanText === "" && parseJobSections(row.sections).length === 0)
        ? null
        : {
            cleanText,
            sections: parseJobSections(row.sections),
            capturedAt: stringOrNull(row.captured_at),
          };

    const company = await loadCompanyContext(client, job.companyDomain);

    return { kind: "success", job, description, company };
  } catch {
    return { kind: "error", message: FAILURE_MESSAGE };
  }
}
