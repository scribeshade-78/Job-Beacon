import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * Lever Postings API (PRD §10.2 [S2]; verified directly against
 * https://github.com/lever/postings-api). Public GET, no authentication.
 *
 * targetKey = site slug (one site = one employer, same reasoning as
 * Greenhouse for why companyName/companyDomain come from target config).
 */
interface LeverTargetConfig extends DiscoveryAdapterConfig {
  companyName: string;
  companyDomain?: string;
}

interface LeverSalaryRange {
  currency?: string;
  interval?: string;
  min?: number;
  max?: number;
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string };
  workplaceType?: "remote" | "hybrid" | "on-site" | "unspecified";
  salaryRange?: LeverSalaryRange;
}

const WORKPLACE_TYPE_MAP: Record<string, DiscoveredVacancy["remoteType"]> = {
  remote: "remote",
  hybrid: "hybrid",
  // THE LIVE SPELLING IS "onsite", NOT "on-site". The leverdemo board returns
  // {"hybrid":3,"onsite":3,"remote":3,"unspecified":1}, so the hyphenated key alone dropped
  // a third of the board to null. Both spellings are kept because the hyphenated form is
  // what the public documentation shows.
  onsite: "on_site",
  "on-site": "on_site",
};

const SALARY_INTERVAL_MAP: Record<string, DiscoveredVacancy["salaryInterval"]> = {
  year: "year",
  annual: "year",
  month: "month",
  monthly: "month",
  hour: "hour",
  hourly: "hour",
};

export class LeverPayloadError extends Error {
  constructor(detail: string) {
    super(`Lever returned a payload this adapter cannot read: ${detail}`);
    this.name = "LeverPayloadError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Non-empty and trimmed, or null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A real finite number, or null. Lever types these as numbers but the body is untyped. */
function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * An unusable timestamp is null, NOT a throw.
 *
 * new Date("not-a-date").toISOString() raises RangeError, and a row-level throw inside the
 * map costs every other posting in the same response. Zero and non-finite values are also
 * null, which preserves the previous truthiness behaviour for an unset createdAt.
 */
function toIsoString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Maps ONE Lever posting, or returns null when it cannot be identified or linked.
 *
 * SKIP, DO NOT REPAIR: vacancies.source_vacancy_id, authoritative_url and raw_title are
 * NOT NULL, so a posting missing any of them is a failed insert or a garbage vacancy.
 */
export function mapLeverPosting(posting: unknown, config: LeverTargetConfig): DiscoveredVacancy | null {
  const record = asRecord(posting);

  const sourceVacancyId = asString(record.id);
  const authoritativeUrl = asString(record.hostedUrl);
  const rawTitle = asString(record.text);

  if (!sourceVacancyId || !authoritativeUrl || !rawTitle) {
    return null;
  }

  const typed = record as unknown as LeverPosting;
  const salary = asRecord(record.salaryRange);

  const min = asFiniteNumber(salary.min);
  const max = asFiniteNumber(salary.max);
  const hasSalary = min !== null || max !== null;

  return {
    sourceVacancyId,
    authoritativeUrl,
    rawTitle,
    companyName: config.companyName,
    companyDomain: config.companyDomain ?? null,
    // categories.location is a single freeform string (e.g. "New York, NY" or
    // "Remote - US"), same ambiguity as Greenhouse's location field — not decomposed into
    // country/region/city without guessing. The raw string survives in `raw` below.
    country: null,
    region: null,
    city: null,
    remoteType:
      typeof typed.workplaceType === "string" ? (WORKPLACE_TYPE_MAP[typed.workplaceType] ?? null) : null,
    // CURRENCY AND INTERVAL FOLLOW THE FIGURE. A salaryRange object with no readable amount
    // is not a disclosed salary, so none of the four salary fields are taken from it — the
    // old truthiness test on the object advertised a disclosed salary with every amount
    // null.
    currency: hasSalary ? asString(salary.currency) : null,
    salaryMin: min,
    salaryMax: max,
    salaryInterval: hasSalary ? parseLeverInterval(salary.interval) : null,
    salarySource: hasSalary ? "employer_disclosed" : null,
    publishedAt: toIsoString(typed.createdAt),
    raw: typed,
  };
}

/**
 * Lever's salary interval is a COMPOUND string, not the bare unit the map holds.
 *
 * The live board sends "per-year-salary" for every posting that has a range, so the
 * exact-key map matched none of them: each row kept its amounts and lost its interval.
 *
 * Matched by UNIT TOKEN rather than by extending the key list, because enumerating a
 * compound vocabulary I cannot verify would rot. Only the three units the schema can
 * represent are returned; anything else is null rather than approximated.
 */
function parseLeverInterval(value: unknown): DiscoveredVacancy["salaryInterval"] {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const exact = SALARY_INTERVAL_MAP[normalized];

  if (exact) {
    return exact;
  }

  if (normalized.includes("year") || normalized.includes("annual")) {
    return "year";
  }

  if (normalized.includes("month")) {
    return "month";
  }

  if (normalized.includes("hour")) {
    return "hour";
  }

  return null;
}

const LEVER_SOURCE_CODE = "lever" as const;

const leverAdapter: DiscoveryAdapter<LeverTargetConfig> = {
  sourceCode: LEVER_SOURCE_CODE,

  async discover(
    siteSlug: string,
    config: LeverTargetConfig,
    fetchImpl: FetchImpl = fetch,
  ): Promise<DiscoveredVacancy[]> {
    this.validateConfig(config);

    const response = await fetchImpl(
      `https://api.lever.co/v0/postings/${encodeURIComponent(siteSlug)}?mode=json`,
    );

    if (!response.ok) {
      throw new Error(`Lever discovery failed for site "${siteSlug}": HTTP ${response.status}`);
    }

    // A MALFORMED BODY IS NAMED, NOT A STACK TRACE. Lever answers with a BARE ARRAY, so a
    // null body or an error object made `.map` itself the TypeError, and the ingestion
    // worker stored that message as the source's health error.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LeverPayloadError("the response body was not JSON");
    }

    if (!Array.isArray(payload)) {
      throw new LeverPayloadError("the response was not a postings array");
    }

    // UNMAPPABLE POSTINGS ARE SKIPPED, NOT REPAIRED — see mapLeverPosting.
    return payload
      .map((posting) => mapLeverPosting(posting, config))
      .filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);
  },

  validateConfig(config: LeverTargetConfig): void {
    if (typeof config.companyName !== "string" || config.companyName.trim() === "") {
      throw new Error(`Lever target config must include a non-empty "companyName" string.`);
    }
  },
};

export { leverAdapter, LEVER_SOURCE_CODE, type LeverTargetConfig };