import type { SupabaseClient } from "@supabase/supabase-js";
import { chromium, type Browser } from "playwright";
import {
  MOCK_FIELD_IDS,
  MOCK_SUCCESS_MARKER_ID,
} from "../../mockEmployer.js";
import type {
  ApplicationAdapter,
  ApplicationSubmissionContext,
  ApplicationSubmissionResult,
  SubmissionResume,
} from "./types.js";

/**
 * Mini-Phase 8 — the first real submission adapter, against a local fixture.
 *
 * WHAT IT ACTUALLY DOES: launches headless Chrome, navigates to the vacancy's
 * own authoritative_url (a /mock-employer/apply route served by this same
 * Express process), fills the three form fields from the candidate's CONFIRMED
 * facts, submits, and asserts the success marker appears. It submits nothing
 * to any third party.
 *
 * WHY NOT JOOBLE OR USAJOBS: neither can be a target. Jooble is an aggregator
 * with no application channel at all, and USAJOBS needs an account login — its
 * own HowToApply text on the seeded postings reads "This post is for viewing
 * purposes only". Both also carry automated_application_allowed = false with
 * policy_version '*-tou-review-pending' and last_legal_review_at = NULL.
 * See 20260917170000_local_fixture_source.sql.
 *
 * NO CANDIDATE DATA IS FABRICATED. Every value written into the form comes
 * from a fact_confirmations row with status 'confirmed', resolved through the
 * same corrected_value ?? fact_value rule resumeGenerator.ts uses, so a value
 * the candidate corrected is the one that gets submitted. A mandatory field
 * with no confirmed fact fails the attempt with a specific reason code instead
 * of submitting a blank or invented value — see MissingRequiredFactError.
 *
 * Playwright drives the INSTALLED Chrome (channel: "chrome") rather than a
 * downloaded build: the Playwright CDN is unreachable from this environment
 * (30s timeout on chrome-win64.zip), and Playwright's channel option is the
 * supported way to use a system browser. PLAYWRIGHT_CHANNEL overrides it.
 */

export const LOCAL_FIXTURE_SOURCE_CODE = "local_fixture";

/** Reason code prefix, so a failed attempt's last_error says why at a glance. */
export const MISSING_REQUIRED_FACT_REASON = "MISSING_REQUIRED_CANDIDATE_FACT";
export const SELECTOR_NOT_FOUND_REASON = "MOCK_SELECTOR_NOT_FOUND";
export const NAVIGATION_REASON = "MOCK_NAVIGATION_FAILED";

/**
 * The fixture form's mandatory inputs. Each maps to one confirmed fact type.
 * A real portal would have a longer, per-board list; this is deliberately the
 * smallest set that exercises "map required inputs to candidate data".
 */
const REQUIRED_FACT_TYPES = [
  { factType: "full_name", fieldId: MOCK_FIELD_IDS.fullName },
  { factType: "email", fieldId: MOCK_FIELD_IDS.email },
  { factType: "phone", fieldId: MOCK_FIELD_IDS.phone },
] as const;

export class MissingRequiredFactError extends Error {
  constructor(public readonly factType: string) {
    super(
      `${MISSING_REQUIRED_FACT_REASON}: no confirmed "${factType}" fact exists for this candidate. Refusing to submit a blank or invented value.`,
    );
    this.name = "MissingRequiredFactError";
  }
}

/**
 * Candidate facts this adapter is allowed to submit, keyed by fact_type.
 * Skips a fact_type with no confirmed row rather than defaulting it, so a
 * missing field surfaces as MissingRequiredFactError at the point of use.
 */
export async function loadConfirmedFactValues(
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

    const effective = correctedByFactId.get(fact.id) ?? fact.fact_value;

    // First confirmed value wins for a repeated fact_type; a candidate with
    // two confirmed "email" facts is a data problem, not a reason to invent a
    // precedence rule here.
    if (!values.has(fact.fact_type)) {
      values.set(fact.fact_type, effective);
    }
  }

  return values;
}

export const MISSING_RESUME_REASON = "MISSING_SUBMISSION_RESUME";

/**
 * Thrown when the adapter is asked to submit without a resume. This is a
 * programming error rather than a runtime failure — submitApplicationAttempt
 * resolves the resume before dispatching — but the form has a mandatory file
 * field, so submitting without one would be rejected by the fixture anyway, and
 * failing here says why.
 */
export class MissingSubmissionResumeError extends Error {
  constructor() {
    super(
      `${MISSING_RESUME_REASON}: no resume was resolved for this attempt. The application form requires one, and uploading a blank file is not an option.`,
    );
    this.name = "MissingSubmissionResumeError";
  }
}

export const RESUME_ATTACH_REASON = "MOCK_RESUME_ATTACH_FAILED";

/** Injected in tests so the form-mapping logic is exercised without a browser. */
export interface LocalFixtureAdapterDeps {
  launchBrowser?: () => Promise<Browser>;
  /** Injected in tests so the Storage download is not exercised for real. */
  downloadResume?: (client: SupabaseClient, resume: SubmissionResume) => Promise<Uint8Array>;
}

/**
 * Downloads the resolved document from the private bucket. The bytes go
 * straight to Playwright as an in-memory payload rather than through a temp
 * file, so a candidate's resume never touches the filesystem.
 */
async function defaultDownloadResume(
  client: SupabaseClient,
  resume: SubmissionResume,
): Promise<Uint8Array> {
  const { data, error } = await client.storage.from("resumes").download(resume.storagePath);

  if (error || !data) {
    throw new Error(
      `${RESUME_ATTACH_REASON}: could not download ${resume.storagePath} — ${error?.message ?? "no data returned"}`,
    );
  }

  return new Uint8Array(await data.arrayBuffer());
}

export function createLocalFixtureAdapter(deps: LocalFixtureAdapterDeps = {}): ApplicationAdapter {
  const launchBrowser =
    deps.launchBrowser ??
    (() =>
      chromium.launch({
        channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
        headless: true,
      }));

  const downloadResume = deps.downloadResume ?? defaultDownloadResume;

  return {
    sourceCode: LOCAL_FIXTURE_SOURCE_CODE,
    displayName: "Local fixture employer (development only)",
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
        .select("authoritative_url, raw_title")
        .eq("id", vacancyId)
        .single();

      if (vacancyError || !vacancy) {
        throw vacancyError ?? new Error(`vacancies row not found for id ${vacancyId}`);
      }

      const targetUrl = (vacancy as { authoritative_url: string }).authoritative_url;
      const facts = await loadConfirmedFactValues(client, candidateId);

      // Resolved BEFORE the browser is launched: opening a browser to then
      // discover a required field has no value is wasted work, and the failure
      // is a data problem, not a rendering one.
      const fieldValues = REQUIRED_FACT_TYPES.map(({ factType, fieldId }) => {
        const value = facts.get(factType)?.trim();

        if (!value) {
          throw new MissingRequiredFactError(factType);
        }

        return { factType, fieldId, value };
      });

      // Also before the browser: a missing or unreadable resume is a data
      // problem too, and downloading it here means the failure is reported
      // without having opened a page that then has nothing to attach.
      //
      // WHICH file this is was decided by resolveSubmissionResume, not here —
      // the candidate's own upload when their preference is 'off', or the
      // tailored PDF generated for this vacancy otherwise. This adapter only
      // carries out that decision.
      const resume = context.resume;

      if (!resume) {
        throw new MissingSubmissionResumeError();
      }

      const resumeBytes = await downloadResume(client, resume);

      if (resumeBytes.byteLength === 0) {
        throw new Error(`${RESUME_ATTACH_REASON}: ${resume.storagePath} downloaded as zero bytes.`);
      }

      const browser = await launchBrowser();

      try {
        const page = await browser.newPage();

        try {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
        } catch (error) {
          throw new Error(
            `${NAVIGATION_REASON}: could not load ${targetUrl} — ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        for (const { fieldId, value } of fieldValues) {
          try {
            await page.fill(`#${fieldId}`, value, { timeout: 5_000 });
          } catch (error) {
            // The "changed selector" failure a real portal adapter must
            // survive. Reported per-field so the evidence says which input
            // broke, not merely that something did.
            throw new Error(
              `${SELECTOR_NOT_FOUND_REASON}: could not fill #${fieldId} — ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        try {
          // Passed as an in-memory payload, so the file is attached from the
          // bytes already read rather than from a path on disk.
          await page.setInputFiles(
            `#${MOCK_FIELD_IDS.resume}`,
            { name: resume.originalFilename, mimeType: resume.mimeType, buffer: Buffer.from(resumeBytes) },
            { timeout: 5_000 },
          );
        } catch (error) {
          throw new Error(
            `${RESUME_ATTACH_REASON}: could not attach the resume to #${MOCK_FIELD_IDS.resume} — ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        try {
          await page.click(`#${MOCK_FIELD_IDS.submit}`, { timeout: 5_000 });
          await page.waitForSelector(`#${MOCK_SUCCESS_MARKER_ID}`, { timeout: 15_000 });
        } catch (error) {
          throw new Error(
            `${SELECTOR_NOT_FOUND_REASON}: submission did not reach the confirmation marker — ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        return {
          evidenceType: "local_fixture_submission",
          payload: {
            targetUrl,
            vacancyTitle: (vacancy as { raw_title: string }).raw_title,
            // Field NAMES and the fact types they came from, never the values:
            // evidence rows are not a place to copy a candidate's email and
            // phone number into a second table.
            fieldsSubmitted: fieldValues.map(({ fieldId, factType }) => ({ fieldId, factType })),
            confirmationMarker: MOCK_SUCCESS_MARKER_ID,
            // Which document was attached, and whether it was the candidate's
            // own file or one generated for this application. The filename is
            // not PII (it is "resume-<vacancy-slug>.pdf" or the uploaded
            // name), and the setting is the whole point of the feature, so the
            // audit trail can answer "was this application tailored?" without
            // joining anything.
            resumeFilename: resume.originalFilename,
            resumeTailored: resume.tailored,
            resumeOptimizationLevel: resume.optimizationLevel,
            adapter: LOCAL_FIXTURE_SOURCE_CODE,
          },
        };
      } finally {
        // Closed on every path, including a thrown fill/click, so a failed
        // attempt cannot leak a browser process into the next one.
        await browser.close();
      }
    },
  };
}

export const localFixtureAdapter = createLocalFixtureAdapter();
