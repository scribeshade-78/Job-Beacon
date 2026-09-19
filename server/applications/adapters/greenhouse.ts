import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApplicationAdapter,
  ApplicationSubmissionContext,
  ApplicationSubmissionResult,
} from "./types.js";
import { atsHttpFailure } from "./errors.js";
import {
  loadAtsCredentialSecret,
  markAtsCredentialUsed,
  type AtsSourceCode,
} from "../../ats/credentials.js";

/**
 * The first production submission adapter — Greenhouse Job Board API.
 *
 * ENDPOINT AND AUTH ARE PRIMARY-SOURCE VERIFIED, not inferred. From the
 * official docs (github.com/grnhse/greenhouse-api-docs,
 * source/includes/job-board/_applications.md):
 *
 *   POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}
 *
 *   "This method requires HTTP Basic Auth over SSL/TLS: the Basic Auth
 *    username is your API key (found on the API Credentials page). No password
 *    is required."
 *
 * THE KEY BELONGS TO THE EMPLOYER, NOT TO US — and that is the whole reason
 * this channel is defensible where Jooble and USAJOBS were not. The employer
 * opts in by issuing a Job Board API key for their own board, so the
 * authorization is theirs to give. The same doc warns that the token is a
 * secret and that form posts "should be proxied by your own servers", which is
 * exactly what this adapter is: a server-side proxy that never exposes the key
 * to a browser.
 *
 * NOTHING IS SCRAPED. No Playwright, no DOM, no selectors — a documented API
 * with a documented multipart contract.
 *
 * CREDENTIALS ARE PER-BOARD, NOT PER-SOURCE, which is a real limitation rather
 * than a detail: one key only ever authorizes submissions to ONE employer's
 * board. This adapter therefore reads a single key from the environment
 * (GREENHOUSE_API_KEY) and is honest that it serves whichever employer issued
 * it. There is no credential-storage table in this schema, and inventing one
 * is a separate decision; see the summary for what that would take.
 */

export const GREENHOUSE_SOURCE_CODE = "greenhouse";
export const GREENHOUSE_BOARD_API_BASE = "https://boards-api.greenhouse.io/v1/boards";

export const MISSING_CREDENTIALS_REASON = "GREENHOUSE_API_KEY_NOT_CONFIGURED";
export const MISSING_REQUIRED_FACT_REASON = "MISSING_REQUIRED_CANDIDATE_FACT";
export const MISSING_RESUME_REASON = "NO_RESUME_DOCUMENT_FOR_CANDIDATE";
export const UNPARSEABLE_TARGET_REASON = "GREENHOUSE_TARGET_UNRESOLVABLE";
export const SUBMISSION_REJECTED_REASON = "GREENHOUSE_SUBMISSION_REJECTED";

export class GreenhouseCredentialsError extends Error {
  constructor() {
    super(
      `${MISSING_CREDENTIALS_REASON}: no employer Job Board API key is configured. The key is issued by the employer whose board is being applied to and is required for Basic Auth.`,
    );
    this.name = "GreenhouseCredentialsError";
  }
}

export class GreenhouseTargetError extends Error {
  constructor(detail: string) {
    super(`${UNPARSEABLE_TARGET_REASON}: ${detail}`);
    this.name = "GreenhouseTargetError";
  }
}

export class MissingRequiredFactError extends Error {
  constructor(factType: string) {
    super(`${MISSING_REQUIRED_FACT_REASON}: no confirmed "${factType}" fact for this candidate.`);
    this.name = "MissingRequiredFactError";
  }
}

export class MissingResumeError extends Error {
  constructor(candidateId: string) {
    super(`${MISSING_RESUME_REASON}: candidate ${candidateId} has no resume_documents row to upload.`);
    this.name = "MissingResumeError";
  }
}

/**
 * The employer's key, read lazily from the environment — same
 * lazy-read-with-injectable-default shape as openaiClient.ts, so importing
 * this module never requires the key to exist.
 */
export interface GreenhouseCredentials {
  apiKey: string;
}

export function readGreenhouseCredentials(env: NodeJS.ProcessEnv = process.env): GreenhouseCredentials {
  const apiKey = env.GREENHOUSE_API_KEY?.trim();

  if (!apiKey) {
    throw new GreenhouseCredentialsError();
  }

  return { apiKey };
}

export interface ResumeUpload {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface GreenhouseAdapterDeps {
  fetchImpl?: typeof fetch;
  /**
   * Task H3: the employer's key, resolved from the encrypted credential store by
   * BOARD TOKEN — the scope a Greenhouse Job Board API key actually has.
   * Injectable so the resolution can be exercised without the store.
   */
  loadCredential?: (client: SupabaseClient, boardToken: string) => Promise<{ id: string; secret: string } | null>;
  env?: Record<string, string | undefined>;
  /**
   * Single-employer fallback, used only when the store has no row for this
   * board. Kept because the pre-H3 tests and a one-employer deployment both use
   * it, and it cannot cause an unauthorized submission: the source_policy gate —
   * which the credential store drives — is what decides whether this adapter is
   * ever reached.
   */
  readCredentials?: () => GreenhouseCredentials;
  /** Injected in tests so the multipart mapping is exercised without Storage. */
  downloadResume?: (client: SupabaseClient, candidateId: string) => Promise<ResumeUpload>;
  /** Used instead of downloadResume whenever the submission context names a document. */
  downloadResumeById?: (client: SupabaseClient, storagePath: string) => Promise<Uint8Array>;
}

const DEFAULT_BUCKET = "resumes";

async function defaultDownloadResume(client: SupabaseClient, candidateId: string): Promise<ResumeUpload> {
  const { data: document, error } = await client
    .from("resume_documents")
    .select("storage_path, original_filename, mime_type")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!document) {
    throw new MissingResumeError(candidateId);
  }

  const row = document as { storage_path: string; original_filename: string; mime_type: string };

  const { data: blob, error: downloadError } = await client.storage.from(DEFAULT_BUCKET).download(row.storage_path);

  if (downloadError || !blob) {
    throw downloadError ?? new Error(`Resume object ${row.storage_path} could not be downloaded from Storage.`);
  }

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    contentType: row.mime_type,
    filename: row.original_filename,
  };
}

/**
 * Splits a confirmed full_name into Greenhouse's separate first_name /
 * last_name fields.
 *
 * Deliberately fails rather than guessing when there is only one token: a
 * single-token name has no last name to send, and inventing one (or sending a
 * blank required field) would fabricate candidate data. Splitting on the LAST
 * space keeps multi-word given names intact ("Mary Jane Watson" ->
 * "Mary Jane" + "Watson").
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  const lastSpace = trimmed.lastIndexOf(" ");

  if (lastSpace === -1) {
    throw new MissingRequiredFactError("last_name (full_name contains no separable last name)");
  }

  return { firstName: trimmed.slice(0, lastSpace), lastName: trimmed.slice(lastSpace + 1) };
}

export interface GreenhouseTarget {
  boardToken: string;
  jobId: string;
}

/**
 * The board token is read from vacancy_sources.target_key — what the discovery
 * adapter was given — and the job id from vacancies.source_vacancy_id, which
 * discovery sets to Greenhouse's own job id. Those are the authoritative
 * columns; the URL is only a fallback for a vacancy that did not come through
 * discovery.
 *
 * (This schema has no external_id column; source_vacancy_id is that field.)
 */
export function resolveGreenhouseTarget(vacancy: {
  sourceVacancyId: string | null;
  authoritativeUrl: string;
  targetKey: string | null;
}): GreenhouseTarget {
  const jobIdFromUrl = /\/jobs\/(\d+)/.exec(vacancy.authoritativeUrl)?.[1] ?? null;
  const boardFromUrl =
    /(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)/.exec(vacancy.authoritativeUrl)?.[1] ?? null;

  const jobId = vacancy.sourceVacancyId?.trim() || jobIdFromUrl;
  const boardToken = vacancy.targetKey?.trim() || boardFromUrl;

  if (!boardToken) {
    throw new GreenhouseTargetError("no board token on vacancy_sources.target_key and none parseable from authoritative_url");
  }
  if (!jobId) {
    throw new GreenhouseTargetError("no job id on vacancies.source_vacancy_id and none parseable from authoritative_url");
  }

  return { boardToken, jobId };
}

interface GreenhouseErrorBody {
  message?: string;
  errors?: unknown;
}

/**
 * Greenhouse returns its own error text; surfacing it beats a bare status code
 * for anyone reading application_evidence later. Falls back to the status line
 * when the body is not the expected JSON.
 */
async function describeFailure(response: Response): Promise<string> {
  let body = "";

  try {
    body = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }

  try {
    const parsed = JSON.parse(body) as GreenhouseErrorBody;
    const detail = parsed.errors ? `${parsed.message ?? ""} ${JSON.stringify(parsed.errors)}`.trim() : parsed.message;
    if (detail) {
      return `HTTP ${response.status}: ${detail}`;
    }
  } catch {
    // not JSON — fall through to the raw body
  }

  return body.trim() === "" ? `HTTP ${response.status}` : `HTTP ${response.status}: ${body.slice(0, 300)}`;
}

/**
 * Candidate facts this adapter submits, keyed by fact_type. Reads
 * fact_confirmations for status='confirmed' and applies the same
 * corrected_value ?? fact_value rule resumeGenerator.ts uses, so a value the
 * candidate corrected is the one that gets sent.
 */
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
    ((confirmationRows ?? []) as Array<{ extracted_fact_id: string; corrected_value: string | null }>).map((row) => [
      row.extracted_fact_id,
      row.corrected_value,
    ]),
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

export function createGreenhouseAdapter(deps: GreenhouseAdapterDeps = {}): ApplicationAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readCredentials = deps.readCredentials ?? (() => readGreenhouseCredentials());
  const env = deps.env ?? process.env;
  const sourceCode: AtsSourceCode = "greenhouse";
  const loadCredential =
    deps.loadCredential ??
    ((client: SupabaseClient, boardToken: string) =>
      loadAtsCredentialSecret(client, sourceCode, boardToken, env));
  const downloadResume = deps.downloadResume ?? defaultDownloadResume;
  const downloadResumeById =
    deps.downloadResumeById ??
    (async (client: SupabaseClient, storagePath: string) => {
      const { data, error } = await client.storage.from(DEFAULT_BUCKET).download(storagePath);
      if (error || !data) {
        throw new Error(`Could not download ${storagePath}: ${error?.message ?? "no data returned"}`);
      }
      return new Uint8Array(await data.arrayBuffer());
    });

  return {
    sourceCode: GREENHOUSE_SOURCE_CODE,
    displayName: "Greenhouse Job Board API",
    isAutomatedSubmissionSupported: true,

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
        throw planError ?? new Error(`application_plans row not found for id ${context.applicationPlanId}`);
      }

      const { vacancy_id: vacancyId, candidate_id: candidateId } = plan as {
        vacancy_id: string;
        candidate_id: string;
      };

      const { data: vacancy, error: vacancyError } = await client
        .from("vacancies")
        .select("source_vacancy_id, authoritative_url, vacancy_source_id, vacancies_source:vacancy_sources (target_key)")
        .eq("id", vacancyId)
        .single();

      if (vacancyError || !vacancy) {
        throw vacancyError ?? new Error(`vacancies row not found for id ${vacancyId}`);
      }

      const vacancyRow = vacancy as unknown as {
        source_vacancy_id: string | null;
        authoritative_url: string;
        vacancies_source: { target_key: string } | null;
      };

      const target = resolveGreenhouseTarget({
        sourceVacancyId: vacancyRow.source_vacancy_id,
        authoritativeUrl: vacancyRow.authoritative_url,
        targetKey: vacancyRow.vacancies_source?.target_key ?? null,
      });

      // Resolved after the target, because the credential is keyed by the board
      // token that target resolution produces. The pre-H3 order read the key
      // first "so the reason is obvious", which was only possible while there was
      // exactly one key for every board.
      const stored = await loadCredential(client, target.boardToken);
      const credentials: GreenhouseCredentials = stored ? { apiKey: stored.secret } : readCredentials();

      const facts = await loadConfirmedFactValues(client, candidateId);

      const fullName = facts.get("full_name")?.trim();
      const email = facts.get("email")?.trim();
      const phone = facts.get("phone")?.trim();

      if (!fullName) throw new MissingRequiredFactError("full_name");
      if (!email) throw new MissingRequiredFactError("email");
      if (!phone) throw new MissingRequiredFactError("phone");

      const { firstName, lastName } = splitFullName(fullName);

      // Mini-Phase 11: when the submission funnel resolved a specific document
      // for this attempt (the candidate's own upload, or a tailored PDF), that
      // is what gets sent. Falling back to "the candidate's most recent
      // resume_documents row" would ignore the candidate's optimization
      // preference entirely — the fallback exists only for direct callers that
      // bypass submitApplicationAttempt, which today means this adapter's own
      // tests. This adapter is still unregistered (no source_policies row), so
      // none of this runs in production yet.
      const resume: ResumeUpload = context.resume
        ? {
            bytes: await downloadResumeById(client, context.resume.storagePath),
            contentType: context.resume.mimeType,
            filename: context.resume.originalFilename,
          }
        : await downloadResume(client, candidateId);

      const form = new FormData();
      form.append("first_name", firstName);
      form.append("last_name", lastName);
      form.append("email", email);
      form.append("phone", phone);
      form.append("id", target.jobId);
      // The filename matters: Greenhouse stores and displays it, and a
      // Blob without one would arrive as "blob".
      form.append("resume", new Blob([resume.bytes], { type: resume.contentType }), resume.filename);

      const url = `${GREENHOUSE_BOARD_API_BASE}/${encodeURIComponent(target.boardToken)}/jobs/${encodeURIComponent(target.jobId)}`;

      const response = await fetchImpl(url, {
        method: "POST",
        // Content-Type is deliberately NOT set. fetch sets
        // "multipart/form-data; boundary=..." itself from the FormData body;
        // setting it by hand is the classic bug that omits the boundary and
        // makes the server unable to parse any part — including the resume.
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.apiKey}:`).toString("base64")}`,
          Accept: "application/json",
        },
        body: form,
      });

      if (!response.ok) {
        // Task H3: classified rather than thrown bare, so the worker can back off
        // on a 429 or a 5xx and stop retrying a validation rejection (PRD §16.2
        // "handles validation/rate limits").
        throw atsHttpFailure(response, await describeFailure(response), SUBMISSION_REJECTED_REASON);
      }

      if (stored) {
        await markAtsCredentialUsed(client, stored.id);
      }

      // Bounded read: a 2xx with a scraped HTML body is not a submission.
      let applicationId: string | number | null = null;

      try {
        const body = (await response.json()) as { id?: string | number };
        applicationId = body?.id ?? null;
      } catch {
        applicationId = null;
      }

      return {
        evidenceType: "greenhouse_submission",
        payload: {
          adapter: GREENHOUSE_SOURCE_CODE,
          endpoint: url,
          boardToken: target.boardToken,
          jobId: target.jobId,
          httpStatus: response.status,
          // Greenhouse's own application id, which is the thing a support
          // conversation or a later status check would reference.
          applicationId,
          // Which key was used, never the key itself: a stored per-employer
          // credential and the single-employer environment fallback are
          // different trust stories, and later evidence should say which applied.
          credentialSource: stored ? "stored" : "environment",
          resumeFilename: resume.filename,
          // Field names only — never the values. Evidence rows are not a
          // second copy of the candidate's contact details.
          fieldsSubmitted: ["first_name", "last_name", "email", "phone", "id", "resume"],
        },
      };
    },
  };
}

export const greenhouseAdapter = createGreenhouseAdapter();
