import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApplicationAdapter,
  ApplicationSubmissionContext,
  ApplicationSubmissionResult,
} from "./types.js";
import { AtsSubmissionError, atsHttpFailure } from "./errors.js";
import {
  loadAtsCredentialSecret,
  markAtsCredentialUsed,
  type AtsSourceCode,
} from "../../ats/credentials.js";

/**
 * Task H3 — the Lever Postings API submission adapter.
 *
 * ENDPOINT, AUTH AND RATE LIMITS ARE PRIMARY-SOURCE VERIFIED, not inferred. From
 * the official documentation the PRD cites as [S2]
 * (raw.githubusercontent.com/lever/postings-api/master/README.md), section
 * "Apply to a job posting":
 *
 *   POST /v0/postings/SITE/POSTING-ID?key=APIKEY
 *
 *   "WARNING: Application create requests are rate limited. Your team will need
 *    to properly handle 429 responses if you build a custom job application
 *    page."
 *   "To use the POST API, you need an API key, which a Super Admin of your
 *    account can generate from your integrations settings page."
 *   "Two fields are required by our system in order to create a candidate: name
 *    and email address."
 *   "our API only accepts resumes in multipart form data mode."
 *   "Note that all job postings in the published state are publicly viewable."
 *
 * THE KEY IS THE EMPLOYER'S, which is what makes this channel permissible at all
 * under PRD §10.2 ("direct submission only with employer authorization"). It is
 * sent as a QUERY PARAMETER because that is the documented contract — and that
 * is also this adapter's sharpest edge, see redactKey below.
 *
 * TWO INSTANCES EXIST. Lever documents a global and an EU instance:
 *   global  https://api.lever.co/v0/postings/
 *   EU      https://api.eu.lever.co/v0/postings/
 * A European employer's postings live on the EU instance, and posting to the
 * wrong one fails. The instance is therefore derived from the vacancy's own
 * authoritative URL rather than defaulted.
 */

export const LEVER_SOURCE_CODE = "lever";
export const LEVER_GLOBAL_API_BASE = "https://api.lever.co/v0/postings";
export const LEVER_EU_API_BASE = "https://api.eu.lever.co/v0/postings";

export const LEVER_MISSING_CREDENTIALS_REASON = "LEVER_CREDENTIAL_NOT_CONFIGURED";
export const LEVER_TARGET_UNRESOLVABLE_REASON = "LEVER_TARGET_UNRESOLVABLE";
export const LEVER_SUBMISSION_REJECTED_REASON = "LEVER_SUBMISSION_REJECTED";
export const LEVER_MISSING_REQUIRED_FACT_REASON = "MISSING_REQUIRED_CANDIDATE_FACT";

export class LeverTargetError extends Error {
  constructor(detail: string) {
    super(LEVER_TARGET_UNRESOLVABLE_REASON + ": " + detail);
    this.name = "LeverTargetError";
  }
}

export class LeverMissingRequiredFactError extends Error {
  constructor(factType: string) {
    super(LEVER_MISSING_REQUIRED_FACT_REASON + ': no confirmed "' + factType + '" fact for this candidate.');
    this.name = "LeverMissingRequiredFactError";
  }
}

export class LeverMissingCredentialError extends Error {
  constructor(employerKey: string) {
    super(
      LEVER_MISSING_CREDENTIALS_REASON +
        ": no active employer API key is stored for Lever site " +
        employerKey +
        '. A Lever Super Admin generates the key from the account\'s integrations settings, and PRD 10.2 permits direct submission only with employer authorization.',
    );
    this.name = "LeverMissingCredentialError";
  }
}

/**
 * Removes the API key from a URL before it is stored or logged.
 *
 * NOT COSMETIC. Lever takes the key as a query parameter, so the full request URL
 * is a bearer credential: anything that records it — application_evidence, an
 * error message, a log line, a support bundle — hands over the employer's key.
 * Every URL this adapter produces for evidence goes through here first, and the
 * live URL exists only as a local variable for the duration of the request.
 */
export function redactKey(url: string): string {
  return url.replace(/([?&]key=)[^&]*/i, "$1REDACTED");
}

export interface LeverTarget {
  site: string;
  postingId: string;
  apiBase: string;
}

/**
 * Resolves the site, posting id and instance.
 *
 * site: vacancy_sources.target_key is the configured source-level value; the
 * credential's employer_key is the per-employer one and wins when present,
 * because that is the field the stored key is scoped to. Parsed from the URL as
 * a last resort.
 *
 * postingId: vacancies.source_vacancy_id is Lever's own posting id (discovery
 * sets it to that); the URL is the fallback.
 *
 * instance: EU only when the authoritative URL says so. Defaulting to global
 * would silently post a European employer's application to the wrong instance.
 */
export function resolveLeverTarget(
  vacancy: {
    sourceVacancyId: string | null;
    authoritativeUrl: string;
    targetKey: string | null;
  },
  employerKey: string | null,
): LeverTarget {
  const url = vacancy.authoritativeUrl;
  const isEu = /(^|\.)eu\.lever\.co/i.test(url);
  const apiBase = isEu ? LEVER_EU_API_BASE : LEVER_GLOBAL_API_BASE;

  // jobs.lever.co/SITE/POSTING-ID  or  jobs.eu.lever.co/SITE/POSTING-ID
  const fromUrl = /lever\.co\/([^/?#]+)\/([0-9a-fA-F-]{8,})/.exec(url);

  const site = employerKey?.trim() || vacancy.targetKey?.trim() || fromUrl?.[1] || null;
  const postingId = vacancy.sourceVacancyId?.trim() || fromUrl?.[2] || null;

  if (!site) {
    throw new LeverTargetError(
      "no Lever site on the stored credential, on vacancy_sources.target_key, or parseable from authoritative_url",
    );
  }
  if (!postingId) {
    throw new LeverTargetError(
      "no posting id on vacancies.source_vacancy_id and none parseable from authoritative_url",
    );
  }

  return { site, postingId, apiBase };
}

/** Lever returns its own error text; surfacing it beats a bare status code for anyone reading evidence later. */
async function describeFailure(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return "HTTP " + response.status;
  }
  return body.trim() === "" ? "HTTP " + response.status : "HTTP " + response.status + ": " + body.slice(0, 300);
}

/** name and email are the two fields Lever requires; reads the same confirmed-fact rule the Greenhouse adapter uses. */
async function loadConfirmedFactValues(
  client: SupabaseClient,
  candidateId: string,
): Promise<Map<string, string>> {
  const { data: factRows, error: factError } = await client
    .from("extracted_facts")
    .select("id, fact_type, fact_value")
    .eq("candidate_id", candidateId);

  if (factError) {
    throw factError;
  }

  const facts = (factRows ?? []) as Array<{ id: string; fact_type: string; fact_value: string }>;
  if (facts.length === 0) {
    return new Map();
  }

  const { data: confirmationRows, error: confirmationError } = await client
    .from("fact_confirmations")
    .select("extracted_fact_id, corrected_value")
    .in("extracted_fact_id", facts.map((fact) => fact.id))
    .eq("status", "confirmed");

  if (confirmationError) {
    throw confirmationError;
  }

  const correctedByFactId = new Map(
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map(
      (row) => [row.extracted_fact_id, row.corrected_value],
    ),
  );

  const values = new Map<string, string>();
  for (const fact of facts) {
    if (!correctedByFactId.has(fact.id)) {
      continue;
    }
    if (!values.has(fact.fact_type)) {
      values.set(fact.fact_type, correctedByFactId.get(fact.id) ?? fact.fact_value);
    }
  }

  return values;
}

const DEFAULT_BUCKET = "resumes";

export interface LeverAdapterDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Injected in tests so the multipart mapping is exercised without Storage. */
  downloadResumeById?: (client: SupabaseClient, storagePath: string) => Promise<Uint8Array>;
  loadCredential?: (
    client: SupabaseClient,
    employerKey: string,
  ) => Promise<{ id: string; secret: string } | null>;
}

export function createLeverAdapter(deps: LeverAdapterDeps = {}): ApplicationAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const sourceCode: AtsSourceCode = "lever";

  const loadCredential =
    deps.loadCredential ??
    ((client: SupabaseClient, employerKey: string) =>
      loadAtsCredentialSecret(client, sourceCode, employerKey, env));

  const downloadResumeById =
    deps.downloadResumeById ??
    (async (client: SupabaseClient, storagePath: string) => {
      const { data, error } = await client.storage.from(DEFAULT_BUCKET).download(storagePath);
      if (error || !data) {
        throw new Error("Could not download " + storagePath + ": " + (error?.message ?? "no data returned"));
      }
      return new Uint8Array(await data.arrayBuffer());
    });

  return {
    sourceCode: LEVER_SOURCE_CODE,
    displayName: "Lever Postings API",
    isAutomatedSubmissionSupported: true,

    /**
     * Capability, not authorization. Whether this candidate may be auto-applied
     * to a Lever vacancy is decided by eligibilityGate.ts's source_policy gate,
     * which reads source_policies.automated_application_allowed — a flag the
     * database derives from whether an active employer credential exists (see
     * 20260917310000). Duplicating that decision here would create a second
     * answer to the same question, so this stays a static capability claim.
     */
    validateSupport() {
      return { supported: true };
    },

    async submit(
      client: SupabaseClient,
      context: ApplicationSubmissionContext,
    ): Promise<ApplicationSubmissionResult> {
      const { data: plan, error: planError } = await client
        .from("application_plans")
        .select("vacancy_id, candidate_id")
        .eq("id", context.applicationPlanId)
        .single();

      if (planError || !plan) {
        throw planError ?? new Error("application_plans row not found for id " + context.applicationPlanId);
      }

      const { vacancy_id: vacancyId, candidate_id: candidateId } = plan as {
        vacancy_id: string;
        candidate_id: string;
      };

      const { data: vacancy, error: vacancyError } = await client
        .from("vacancies")
        .select("source_vacancy_id, authoritative_url, vacancies_source:vacancy_sources (target_key)")
        .eq("id", vacancyId)
        .single();

      if (vacancyError || !vacancy) {
        throw vacancyError ?? new Error("vacancies row not found for id " + vacancyId);
      }

      const vacancyRow = vacancy as unknown as {
        source_vacancy_id: string | null;
        authoritative_url: string;
        vacancies_source: { target_key: string } | null;
      };

      // Resolved before the credential lookup because the credential is keyed by
      // the employer, which is what the target resolution names.
      const provisionalSite =
        vacancyRow.vacancies_source?.target_key?.trim() ||
        /lever\.co\/([^/?#]+)\//.exec(vacancyRow.authoritative_url)?.[1] ||
        null;

      if (!provisionalSite) {
        throw new LeverTargetError(
          "no Lever site on vacancy_sources.target_key and none parseable from authoritative_url",
        );
      }

      const credential = await loadCredential(client, provisionalSite);

      if (!credential) {
        throw new LeverMissingCredentialError(provisionalSite);
      }

      const target = resolveLeverTarget(
        {
          sourceVacancyId: vacancyRow.source_vacancy_id,
          authoritativeUrl: vacancyRow.authoritative_url,
          targetKey: vacancyRow.vacancies_source?.target_key ?? null,
        },
        provisionalSite,
      );

      const facts = await loadConfirmedFactValues(client, candidateId);

      const name = facts.get("full_name")?.trim();
      const email = facts.get("email")?.trim();
      const phone = facts.get("phone")?.trim();

      if (!name) throw new LeverMissingRequiredFactError("full_name");
      if (!email) throw new LeverMissingRequiredFactError("email");

      if (!context.resume) {
        throw new Error("NO_RESUME_DOCUMENT_FOR_CANDIDATE: no submission resume was resolved for this attempt.");
      }

      const bytes = await downloadResumeById(client, context.resume.storagePath);

      const form = new FormData();
      form.append("name", name);
      form.append("email", email);
      if (phone) {
        form.append("phone", phone);
      }
      // 'resume' is documented as multipart-only, which is the mode used here.
      form.append(
        "resume",
        new Blob([bytes], { type: context.resume.mimeType }),
        context.resume.originalFilename,
      );

      // 'silent' is deliberately NOT sent. It "disables confirmation email sent
      // to candidates upon application", and suppressing the employer's own
      // confirmation to the candidate would make an autonomously submitted
      // application less visible to the person it is for. The default (candidate
      // is emailed) is the transparent behaviour, so the field is omitted rather
      // than set to either value.
      //
      // 'source' is also omitted: tagging candidates with an automation
      // attribution is a product decision nobody has made, and Lever's field is
      // documented for a channel label like 'LinkedIn'.

      const liveUrl =
        target.apiBase +
        "/" +
        encodeURIComponent(target.site) +
        "/" +
        encodeURIComponent(target.postingId) +
        "?key=" +
        encodeURIComponent(credential.secret);

      const response = await fetchImpl(liveUrl, {
        method: "POST",
        // Content-Type is deliberately not set: fetch writes
        // "multipart/form-data; boundary=..." from the FormData body, and setting
        // it by hand is the classic bug that omits the boundary so the server
        // cannot parse any part, including the resume.
        headers: { Accept: "application/json" },
        body: form,
      });

      if (!response.ok) {
        throw atsHttpFailure(response, await describeFailure(response), LEVER_SUBMISSION_REJECTED_REASON);
      }

      await markAtsCredentialUsed(client, credential.id);

      let leverCandidateId: string | null = null;
      try {
        const body = (await response.json()) as { candidateId?: string; id?: string };
        leverCandidateId = body?.candidateId ?? body?.id ?? null;
      } catch {
        leverCandidateId = null;
      }

      return {
        evidenceType: "lever_submission",
        payload: {
          adapter: LEVER_SOURCE_CODE,
          // Redacted: the live URL carries the employer's key in its query string.
          endpoint: redactKey(liveUrl),
          site: target.site,
          postingId: target.postingId,
          instance: target.apiBase === LEVER_EU_API_BASE ? "eu" : "global",
          httpStatus: response.status,
          leverCandidateId,
          resumeFilename: context.resume.originalFilename,
          // Field names only, never values.
          fieldsSubmitted: ["name", "email", ...(phone ? ["phone"] : []), "resume"],
        },
      };
    },
  };
}

export const leverAdapter = createLeverAdapter();
