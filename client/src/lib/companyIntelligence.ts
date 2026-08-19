import type { SupabaseClient } from "@supabase/supabase-js";

export interface CompanyLegalEntitySummary {
  id: string;
  jurisdiction: string;
  registryIdentifier: string;
  legalName: string;
  registrationStatus: string | null;
  companyClass: string | null;
}

export interface CompanyProfileSummary {
  headquartersCountry: string | null;
  operatingCountries: string[] | null;
  industry: string | null;
  foundedYear: number | null;
  employeeSizeRange: string | null;
  publicPrivateStatus: string | null;
}

export interface CompanyIntelligenceEntry {
  companyId: string;
  displayedName: string;
  domain: string | null;
  careerDomain: string | null;
  profile: CompanyProfileSummary;
  legalEntities: CompanyLegalEntitySummary[];
}

interface CompanyRow {
  id: string;
  displayed_name: string;
  domain: string | null;
  career_domain: string | null;
  company_profiles: {
    headquarters_country: string | null;
    operating_countries: string[] | null;
    industry: string | null;
    founded_year: number | null;
    employee_size_range: string | null;
    public_private_status: string | null;
  };
  company_legal_entities: Array<{
    id: string;
    jurisdiction: string;
    registry_identifier: string;
    legal_name: string;
    registration_status: string | null;
    company_class: string | null;
  }> | null;
}

const COMPANIES_FAILURE_MESSAGE = "Could not load verified company profiles. Please try again.";

export type ListVerifiedCompaniesResult =
  | { kind: "success"; companies: CompanyIntelligenceEntry[] }
  | { kind: "error"; message: string };

/**
 * Reads companies that have a verified company_profiles row, joined to
 * their legal entities (R5.1/R5.4) — public-within-the-app reference
 * data (companies_select_all/company_profiles_select_all/
 * company_legal_entities_select_all all use `using (true)`, no owner
 * scoping), so this is a direct query, same as every other candidate
 * read in this file's sibling modules. company_profiles!inner excludes
 * companies with no verified profile yet, rather than listing every
 * ingested company with a wall of empty fields.
 */
export async function listVerifiedCompanies(
  client: Pick<SupabaseClient, "from">,
): Promise<ListVerifiedCompaniesResult> {
  try {
    const { data, error } = await client
      .from("companies")
      .select(
        "id, displayed_name, domain, career_domain, company_profiles!inner (headquarters_country, operating_countries, industry, founded_year, employee_size_range, public_private_status), company_legal_entities (id, jurisdiction, registry_identifier, legal_name, registration_status, company_class)",
      )
      .order("displayed_name", { ascending: true });

    if (error || !data) {
      return { kind: "error", message: COMPANIES_FAILURE_MESSAGE };
    }

    const rows = data as unknown as CompanyRow[];

    return {
      kind: "success",
      companies: rows.map((row) => ({
        companyId: row.id,
        displayedName: row.displayed_name,
        domain: row.domain,
        careerDomain: row.career_domain,
        profile: {
          headquartersCountry: row.company_profiles.headquarters_country,
          operatingCountries: row.company_profiles.operating_countries,
          industry: row.company_profiles.industry,
          foundedYear: row.company_profiles.founded_year,
          employeeSizeRange: row.company_profiles.employee_size_range,
          publicPrivateStatus: row.company_profiles.public_private_status,
        },
        legalEntities: (row.company_legal_entities ?? []).map((entity) => ({
          id: entity.id,
          jurisdiction: entity.jurisdiction,
          registryIdentifier: entity.registry_identifier,
          legalName: entity.legal_name,
          registrationStatus: entity.registration_status,
          companyClass: entity.company_class,
        })),
      })),
    };
  } catch {
    return { kind: "error", message: COMPANIES_FAILURE_MESSAGE };
  }
}

export interface SalaryBenchmarkEntry {
  id: string;
  roleLabel: string;
  region: string | null;
  currency: string;
  salaryInterval: string;
  salaryMin: number | null;
  salaryMax: number | null;
  benchmarkSource: string;
  effectiveDate: string | null;
}

interface SalaryBenchmarkRow {
  id: string;
  role_label: string;
  region: string | null;
  currency: string;
  salary_interval: string;
  salary_min: number | null;
  salary_max: number | null;
  benchmark_source: string;
  effective_date: string | null;
}

const BENCHMARKS_FAILURE_MESSAGE = "Could not load salary benchmarks. Please try again.";

export type ListSalaryBenchmarksResult =
  | { kind: "success"; benchmarks: SalaryBenchmarkEntry[] }
  | { kind: "error"; message: string };

/**
 * Reads salary_benchmarks (R5.2) — same public-within-the-app,
 * RLS-scoped-to-`using (true)` pattern as listVerifiedCompanies.
 */
export async function listSalaryBenchmarks(
  client: Pick<SupabaseClient, "from">,
): Promise<ListSalaryBenchmarksResult> {
  try {
    const { data, error } = await client
      .from("salary_benchmarks")
      .select("id, role_label, region, currency, salary_interval, salary_min, salary_max, benchmark_source, effective_date")
      .order("role_label", { ascending: true });

    if (error || !data) {
      return { kind: "error", message: BENCHMARKS_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      benchmarks: (data as unknown as SalaryBenchmarkRow[]).map((row) => ({
        id: row.id,
        roleLabel: row.role_label,
        region: row.region,
        currency: row.currency,
        salaryInterval: row.salary_interval,
        salaryMin: row.salary_min,
        salaryMax: row.salary_max,
        benchmarkSource: row.benchmark_source,
        effectiveDate: row.effective_date,
      })),
    };
  } catch {
    return { kind: "error", message: BENCHMARKS_FAILURE_MESSAGE };
  }
}
