import type { DiscoveredVacancy, FetchImpl } from "../../ingestion/types.js";
import type { IntakeAdapter, IntakeFetchResult, IntakeQuery } from "./types.js";

/**
 * Task W — the first live intake adapter: Remotive's public job API.
 *
 * No key, no account, no scraping: https://remotive.com/api/remote-jobs is a
 * documented public endpoint whose response carries its own terms notice (see
 * 20260917210000_remotive_intake_source.sql, which quotes it in full and
 * records the position taken on it). Two of those terms are implemented here
 * rather than assumed:
 *
 *   * authoritative_url is Remotive's OWN url for the posting, never the
 *     employer's ATS link scraped out of the body — that is the link-back the
 *     notice requires, and it is also simply the honest provenance: this
 *     repository did not fetch the job from the employer.
 *   * publishedAt is Remotive's publication_date, which the notice says is
 *     delayed by 24 hours. Nothing here describes these as real-time.
 */

export const REMOTIVE_SOURCE_CODE = "remotive";
export const REMOTIVE_API_BASE = "https://remotive.com/api/remote-jobs";
/** Which reading of Remotive's terms these postings were ingested under. */
export const REMOTIVE_NOTICE_VERSION = "remotive-api-notice-v1";

export class RemotivePayloadError extends Error {
  constructor(detail: string) {
    super(`Remotive returned a payload this adapter cannot read: ${detail}`);
    this.name = "RemotivePayloadError";
  }
}

interface RemotiveJob {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  company_name?: unknown;
  category?: unknown;
  job_type?: unknown;
  publication_date?: unknown;
  candidate_required_location?: unknown;
  salary?: unknown;
  description?: unknown;
  tags?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Maps one Remotive posting onto the shared DiscoveredVacancy shape.
 *
 * THREE DELIBERATE NON-MAPPINGS, each because the honest answer is "we do not
 * know" rather than a plausible guess:
 *
 * 1. country is NULL. Remotive publishes candidate_required_location, which is
 *    free text about where the CANDIDATE must be ("Northern America, LATAM,
 *    Europe, APAC", "Worldwide", "Europe, USA, UK, Canada, Australia,
 *    Singapore"). It is not the employer's country, and it is frequently not a
 *    country at all. The string is carried verbatim in region, which is the
 *    closest true column, and in the raw payload.
 *
 * 2. salary_min / salary_max / salary_interval / currency are NULL, even
 *    though Remotive publishes a salary string. That string has no grammar:
 *    real values in one page included "$31,2k- $52k" (31.2k or 312k? the comma
 *    is a decimal separator in some locales and a thousands separator in
 *    others), "OTE $25k - $35k" (on-target earnings, not base salary), and
 *    "$10K-$20K" with no interval at all — where any interval we supplied
 *    would be an inference, not data. A wrong number in a salary column is
 *    worse for a candidate than an empty one, so the raw string is preserved
 *    in the stored payload and no number is invented.
 *
 * 3. companyDomain is NULL. Remotive hosts company logos itself; it never
 *    publishes the employer's own domain, and deriving one from the company
 *    name would be exactly the "infer identity from a name" move the trust
 *    system scores against.
 *
 * remoteType IS set, and that is a property of the source rather than an
 * inference from the listing: every posting on this board is a remote role.
 */
export function mapRemotiveJob(job: RemotiveJob, fetchedAt: string): DiscoveredVacancy | null {
  const id = job.id;
  const url = asString(job.url);
  const title = asString(job.title);
  const companyName = asString(job.company_name);

  // A posting missing any of these cannot be identified, linked to, or
  // attributed. Skipped rather than repaired — see fetchLiveJobs.
  if ((typeof id !== "number" && typeof id !== "string") || !url || !title || !companyName) {
    return null;
  }

  return {
    sourceVacancyId: String(id),
    authoritativeUrl: url,
    rawTitle: title,
    companyName,
    companyDomain: null,
    country: null,
    region: asString(job.candidate_required_location),
    city: null,
    remoteType: "remote",
    currency: null,
    salaryMin: null,
    salaryMax: null,
    salaryInterval: null,
    salarySource: null,
    publishedAt: asString(job.publication_date),
    raw: {
      ...job,
      _intake: {
        source: REMOTIVE_SOURCE_CODE,
        noticeVersion: REMOTIVE_NOTICE_VERSION,
        fetchedAt,
      },
    },
  };
}

export const remotiveIntakeAdapter: IntakeAdapter = {
  sourceCode: REMOTIVE_SOURCE_CODE,
  displayName: "Remotive (public remote-job API)",
  attribution: "Job data from Remotive (https://remotive.com), delayed by 24 hours.",

  async fetchLiveJobs(query: IntakeQuery, fetchImpl: FetchImpl = fetch): Promise<IntakeFetchResult> {
    const url = new URL(REMOTIVE_API_BASE);

    if (query.search) {
      url.searchParams.set("search", query.search);
    }

    // Asked for rather than assumed: Remotive caps and filters server-side, and
    // the slice below is what actually enforces this caller's limit when it
    // returns more than requested.
    url.searchParams.set("limit", String(query.limit));

    const response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new RemotivePayloadError(`HTTP ${response.status} from ${url.toString()}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RemotivePayloadError("the response body was not JSON");
    }

    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { jobs?: unknown }).jobs)) {
      throw new RemotivePayloadError("the response had no jobs array");
    }

    const jobs = (payload as { jobs: RemotiveJob[] }).jobs;
    const fetchedAt = new Date().toISOString();

    // A single unreadable listing is skipped, not fatal: one malformed record
    // in a page of results is not a reason to ingest none of them. The count is
    // returned rather than swallowed, so "ingested fewer than you asked for" is
    // explainable instead of mysterious.
    const mapped = jobs.map((job) => mapRemotiveJob(job, fetchedAt));
    const vacancies = mapped.filter((vacancy): vacancy is DiscoveredVacancy => vacancy !== null);

    return {
      vacancies: vacancies.slice(0, query.limit),
      received: jobs.length,
      skipped: mapped.length - vacancies.length,
    };
  },
};
