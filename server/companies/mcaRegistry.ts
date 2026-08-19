export type FetchImpl = typeof fetch;

export interface McaCredentials {
  apiKey: string;
  resourceId: string;
}

export interface McaCompanyRecord {
  cin: string;
  legalName: string;
  registrationStatus: string | null;
  registrationDate: string | null;
  companyCategory: string | null;
  companyClass: string | null;
  authorizedCapital: number | null;
  paidUpCapital: number | null;
  registeredRegion: string | null;
  registrar: string | null;
  /** Raw provider record for this one company, stored verbatim in company_registry_records. */
  raw: unknown;
}

export class McaRateLimitedError extends Error {
  constructor(cin: string) {
    super(`MCA lookup for CIN "${cin}" was rate-limited (HTTP 429).`);
    this.name = "McaRateLimitedError";
  }
}

export class McaRecordNotFoundError extends Error {
  constructor(cin: string) {
    super(`No MCA company record found for CIN "${cin}".`);
    this.name = "McaRecordNotFoundError";
  }
}

interface McaOgdResponse {
  records?: Array<Record<string, unknown>>;
}

/**
 * Field key names below are a best-effort guess from the R5.3 spike's
 * secondary-source field list — data.gov.in's own catalog page returned
 * HTTP 403 to a direct fetch during that spike, so no live API response
 * was ever actually seen. This mapping is UNVERIFIED and must be
 * corrected against a real response (once a data.gov.in account and the
 * dataset's resourceId are available) before this is trusted with
 * production data. Uppercase-underscore naming matches the typical
 * raw-CSV-derived column convention data.gov.in OGD datasets use, not a
 * confirmed schema.
 */
function parseMcaRecord(record: Record<string, unknown>): McaCompanyRecord {
  const cin = record.CIN;
  const legalName = record.COMPANY_NAME;

  if (typeof cin !== "string" || typeof legalName !== "string") {
    throw new Error("Unexpected MCA record shape — missing CIN or COMPANY_NAME field.");
  }

  return {
    cin,
    legalName,
    registrationStatus: typeof record.COMPANY_STATUS === "string" ? record.COMPANY_STATUS : null,
    registrationDate: typeof record.DATE_OF_REGISTRATION === "string" ? record.DATE_OF_REGISTRATION : null,
    companyCategory: typeof record.COMPANY_CATEGORY === "string" ? record.COMPANY_CATEGORY : null,
    companyClass: typeof record.COMPANY_CLASS === "string" ? record.COMPANY_CLASS : null,
    authorizedCapital: typeof record.AUTHORIZED_CAP === "number" ? record.AUTHORIZED_CAP : null,
    paidUpCapital: typeof record.PAIDUP_CAPITAL === "number" ? record.PAIDUP_CAPITAL : null,
    registeredRegion: typeof record.REGISTERED_STATE === "string" ? record.REGISTERED_STATE : null,
    registrar: typeof record.ROC_CODE === "string" ? record.ROC_CODE : null,
    raw: record,
  };
}

/**
 * India MCA Company Master Data, via data.gov.in's OGD Platform
 * (PRD §14.1 [S9] — verified as far as the R5.3 spike could reach:
 * https://data.gov.in/catalog/company-master-data returned HTTP 403 to
 * a direct fetch, so the endpoint shape here follows the general
 * api.data.gov.in resource pattern confirmed via secondary sources
 * (a PyPI package and third-party tool listings), not this dataset's own
 * documentation page directly).
 *
 * Looks up by CIN, not by company name — company name matching is the
 * same "different companies can share a display name" risk the
 * companies (R2) migration already documents, made worse for legal
 * identity data. A caller must already know the CIN; discovering it in
 * the first place is a separate, unsolved problem (out of R5.6 scope).
 */
export async function fetchMcaCompanyByCin(
  cin: string,
  credentials: McaCredentials,
  fetchImpl: FetchImpl = fetch,
): Promise<McaCompanyRecord> {
  if (!credentials.apiKey || !credentials.resourceId) {
    throw new Error("MCA registry lookup requires an apiKey and resourceId — none configured.");
  }

  const params = new URLSearchParams({
    "api-key": credentials.apiKey,
    format: "json",
    "filters[CIN]": cin,
  });

  const response = await fetchImpl(
    `https://api.data.gov.in/resource/${encodeURIComponent(credentials.resourceId)}?${params.toString()}`,
    { headers: { Accept: "application/json" } },
  );

  if (response.status === 429) {
    throw new McaRateLimitedError(cin);
  }

  if (!response.ok) {
    throw new Error(`MCA registry lookup failed for CIN "${cin}": HTTP ${response.status}`);
  }

  const body = (await response.json()) as McaOgdResponse;
  const record = body.records?.[0];

  if (!record) {
    throw new McaRecordNotFoundError(cin);
  }

  return parseMcaRecord(record);
}
