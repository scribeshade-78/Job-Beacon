import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chromium, type Browser } from "playwright";
import { runAtsFormatChecks, type AtsCheckDeps } from "./atsChecks.js";
import type {
  GroundedText,
  ResumeFactEntry,
  ResumeOptimizationLevel,
  TailoredResumeContent,
} from "./resumeGenerator.js";
import {
  isResumeOptimizationLevel,
  loadBaseResumeDocument,
  type BaseResumeDocument,
} from "./resumeGenerator.js";

/**
 * Mini-Phase 11 — turning tailored content into a file the submission adapter
 * can actually upload.
 *
 * FORMAT: PDF, rendered by Playwright's print-to-PDF from an HTML template.
 *
 * Why not a PDF library: none is installed, and the only PDF dependency here
 * (pdf-parse) reads rather than writes. Why not HTML: the resume_documents
 * mime_type CHECK and the private 'resumes' bucket's allowed_mime_types both
 * accept only application/pdf and the DOCX type, and both are the real
 * enforcement boundary — storing HTML would mean widening the schema so a
 * resume could be a format most application portals will not accept. Why
 * Playwright rather than a new dependency: it is already here and already used
 * in production code (adapters/localFixture.ts drives installed Chrome to
 * submit), so this adds no new runtime surface. It is listed under
 * devDependencies today and is now imported by production code — see the
 * summary; that classification needs to change.
 *
 * A NOTE ON WHAT THIS RENDERS. Every string below comes from either a
 * confirmed extracted_fact or a TailoredResumeContent claim that
 * tailorResumeForVacancy has already checked against those facts. This module
 * does not re-verify: it renders. The verification is a gate before this point,
 * not a property of this point.
 */

export const TAILORED_RESUME_MIME_TYPE = "application/pdf";
export const RESUME_BUCKET = "resumes";

/**
 * How long a preview link stays valid.
 *
 * Long enough to read a one-page resume — the client's own
 * getResumeSignedUrl uses 60 seconds, which is fine for a click-through
 * download and too short for a pane the candidate is reading in.
 *
 * Short enough that a URL pasted into a chat or a browser history is not a
 * lasting key to a private document: signed URLs are bearer capabilities, and
 * anyone holding one can fetch the file without any further check.
 */
export const PREVIEW_URL_TTL_SECONDS = 300;

/**
 * A time-limited URL for one stored document.
 *
 * SIGNED WITH WHATEVER CLIENT IS PASSED IN, AND THAT MATTERS. Signed through
 * the service-role client — which is what the candidate preview route uses,
 * because it needs to read a document before the candidate's own role could
 * have generated it — the storage policies are bypassed entirely. The signed
 * URL is therefore only as safe as the ownership check that happened before
 * this function was called; it is not a second line of defence. See
 * loadOwnedAttempt in attemptReview.ts.
 */
export async function createResumePreviewUrl(
  client: Pick<SupabaseClient, "storage">,
  storagePath: string,
  ttlSeconds: number = PREVIEW_URL_TTL_SECONDS,
): Promise<string> {
  const { data, error } = await client.storage.from(RESUME_BUCKET).createSignedUrl(storagePath, ttlSeconds);

  if (error || !data) {
    throw new TailoredResumeStorageError(
      `could not sign a preview URL for ${storagePath}: ${error?.message ?? "no data returned"}`,
    );
  }

  return data.signedUrl;
}

export class TailoredResumeRenderError extends Error {
  constructor(detail: string) {
    super(`Could not render the tailored resume to PDF: ${detail}`);
    this.name = "TailoredResumeRenderError";
  }
}

export class TailoredResumeStorageError extends Error {
  constructor(detail: string) {
    super(`Could not store the tailored resume: ${detail}`);
    this.name = "TailoredResumeStorageError";
  }
}

/**
 * HTML-escapes a value before it reaches the document. The values are the
 * candidate's own facts and model output, not third-party input, but a resume
 * containing a literal "<" or "&" (a company name, a job title) would otherwise
 * silently corrupt the rendered file — and "the model happened to emit a tag"
 * is not a thing to discover from a broken PDF.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A filename-safe slug of the vacancy title, for the uploaded file's name. */
export function resumeFilenameFor(vacancyTitle: string): string {
  const slug = vacancyTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  return `resume-${slug || "tailored"}.pdf`;
}

export interface TailoredResumeHtmlInput {
  content: TailoredResumeContent;
  /** The candidate's confirmed facts, used only for the contact header. */
  facts: ResumeFactEntry[];
  vacancyTitle: string;
}

/** First confirmed value for a fact_type, or null. */
function factValue(facts: ResumeFactEntry[], factType: string): string | null {
  const match = facts.find((fact) => fact.factType === factType && fact.factValue.trim().length > 0);
  return match ? match.factValue.trim() : null;
}

function textOf(claim: GroundedText): string {
  return claim.text.trim();
}

/**
 * Renders the resume to a single self-contained HTML string. No external
 * stylesheet, font, or image is referenced: Playwright renders this with no
 * network access, so a remote resource would either hang the render or silently
 * drop out of the PDF.
 */
export function renderTailoredResumeHtml(input: TailoredResumeHtmlInput): string {
  const { content, facts, vacancyTitle } = input;

  const fullName = factValue(facts, "full_name");
  const contact = [factValue(facts, "email"), factValue(facts, "phone"), factValue(facts, "location")].filter(
    (value): value is string => value !== null,
  );

  const headline = textOf(content.headline);
  const summary = textOf(content.summary);
  const bullets = content.bullets.map(textOf).filter((text) => text.length > 0);
  const skills = content.skills.map(textOf).filter((text) => text.length > 0);

  const sections: string[] = [];

  if (headline) {
    sections.push(`<p class="headline">${escapeHtml(headline)}</p>`);
  }

  if (summary) {
    sections.push(`<section><h2>Summary</h2><p>${escapeHtml(summary)}</p></section>`);
  }

  if (bullets.length > 0) {
    sections.push(
      `<section><h2>Experience</h2><ul>${bullets
        .map((bullet) => `<li>${escapeHtml(bullet)}</li>`)
        .join("")}</ul></section>`,
    );
  }

  if (skills.length > 0) {
    sections.push(`<section><h2>Skills</h2><p>${escapeHtml(skills.join(" • "))}</p></section>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(fullName ?? "Resume")}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #111;
    margin: 0;
  }
  h1 { font-size: 19pt; margin: 0 0 2pt; letter-spacing: -0.2pt; }
  .contact { margin: 0 0 10pt; color: #444; font-size: 9.5pt; }
  .headline { margin: 0 0 12pt; font-size: 11.5pt; font-weight: 600; }
  section { margin: 0 0 12pt; }
  h2 {
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: 0.7pt;
    color: #555;
    margin: 0 0 5pt;
    padding-bottom: 2pt;
    border-bottom: 0.6pt solid #ccc;
  }
  ul { margin: 0; padding-left: 14pt; }
  li { margin: 0 0 3pt; }
  p { margin: 0; }
</style>
</head>
<body>
  <h1>${escapeHtml(fullName ?? "Candidate")}</h1>
  ${contact.length > 0 ? `<p class="contact">${escapeHtml(contact.join(" • "))}</p>` : ""}
  ${sections.join("\n  ")}
</body>
</html>`;
}

/**
 * The vacancy title is passed in rather than queried for here so this stays a
 * pure rendering step — the resolver already read the vacancy once.
 */
export interface RenderPdfDeps {
  launchBrowser?: () => Promise<Browser>;
  /**
   * Task H3: flows through so the ATS quality checks can be exercised without a
   * real PDF. Optional, because the real extractor is the correct default and a
   * caller should have to say so explicitly to get anything else.
   */
  atsCheckDeps?: AtsCheckDeps;
}

export async function renderPdfFromHtml(html: string, deps: RenderPdfDeps = {}): Promise<Uint8Array> {
  const launchBrowser =
    deps.launchBrowser ??
    (() =>
      chromium.launch({
        // Task J. channel and executablePath select DIFFERENT things and are
        // mutually exclusive in intent: channel picks a Playwright-managed build
        // (chrome, msedge), while executablePath points at a browser already on
        // the machine.
        //
        // THAT DISTINCTION IS WHAT MAKES A musl CONTAINER POSSIBLE. Playwright's
        // managed browser builds link against glibc, so none of them run on
        // Alpine. Alpine ships its own musl-built Chromium at
        // /usr/bin/chromium-browser, and the only way to use it is
        // executablePath — hence this option. Unset, behaviour is exactly what
        // it was before: channel, defaulting to the system Chrome that local
        // development already relies on.
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
          : { channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" }),
        // Space-separated, so a container can pass the flags it needs without a
        // code change. Docker's default /dev/shm is 64 MB and Chromium crashes
        // rendering into it, which is why the container sets
        // --disable-dev-shm-usage; see docker-compose.prod.yml.
        ...(process.env.PLAYWRIGHT_LAUNCH_ARGS
          ? { args: process.env.PLAYWRIGHT_LAUNCH_ARGS.split(/\s+/).filter(Boolean) }
          : {}),
        headless: true,
      }));

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();

    try {
      // waitUntil "load" (not networkidle): nothing here loads from the
      // network, so waiting for idle would only add a timeout to every render.
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({ format: "A4", printBackground: true });

      if (pdf.byteLength === 0) {
        throw new TailoredResumeRenderError("the renderer produced an empty document");
      }

      return new Uint8Array(pdf);
    } finally {
      await page.close();
    }
  } finally {
    // Closed on every path, including a thrown render, so a failed tailoring
    // cannot leak a browser process into the next attempt — same discipline as
    // localFixture.ts.
    await browser.close();
  }
}

export interface StoreTailoredResumeInput {
  candidateId: string;
  vacancyId: string;
  vacancyTitle: string;
  content: TailoredResumeContent;
  facts: ResumeFactEntry[];
  /** The level that produced this content, recorded on the row so a later read never has to guess it. */
  optimizationLevel: Exclude<ResumeOptimizationLevel, "off">;
  /**
   * Task H3, PRD §16.3 "Record source facts, template version, model/prompt
   * version and output hash." The generator already produces all three and this
   * function used to discard them, recording only the file. Optional rather than
   * required so existing callers and tests keep compiling; NULL means "not
   * supplied", which is honest for a document generated before H3.
   */
  templateVersion?: string;
  modelVersion?: string;
  /** SHA-256 of the confirmed facts the content was built from — a different thing from the document hash, see below. */
  factsSha256?: string;
}

/**
 * Renders, uploads and records one tailored resume, returning the row that
 * submission will reference.
 *
 * ORDER: render -> upload -> insert. Same reasoning as lib/resume.ts
 * uploadResume: a failure between upload and insert leaves an orphaned private
 * object that nothing references, which is recoverable; an insert that
 * succeeded before the upload would leave a row pointing at a file that does
 * not exist, which is not.
 *
 * The storage path mirrors uploadResume's `{candidateId}/{uuid}-{filename}`
 * shape so both kinds of document live under the same convention. The uuid is
 * what keeps storage_path (UNIQUE) satisfied when the same candidate applies to
 * the same vacancy twice: a regenerated resume is a new document, deliberately,
 * because it was produced under a possibly different setting and must not
 * silently overwrite the file an earlier application referenced.
 */
export async function storeTailoredResume(
  client: SupabaseClient,
  deps: RenderPdfDeps,
  input: StoreTailoredResumeInput,
): Promise<BaseResumeDocument> {
  const html = renderTailoredResumeHtml({
    content: input.content,
    facts: input.facts,
    vacancyTitle: input.vacancyTitle,
  });

  const bytes = await renderPdfFromHtml(html, deps);

  // Task H3, PRD §16.3. The hash is taken over THE EXACT BYTES THAT ARE
  // UPLOADED, computed here rather than inside the upload, so the recorded value
  // describes the object that exists in storage and not a buffer that was
  // transformed on the way. `resume_documents.output_sha256` is what later proves
  // a submitted file is the file that was generated.
  const outputSha256 = createHash("sha256").update(bytes).digest("hex");

  // §16.3's "formatting and ATS quality checks". Run before the upload so a
  // document that cannot survive an ATS is recorded as such rather than
  // silently becoming submittable; the outcome is stored either way, because
  // "this file was checked and failed" is more useful than an absent record.
  const atsChecks = await runAtsFormatChecks(bytes, TAILORED_RESUME_MIME_TYPE, deps.atsCheckDeps ?? {});

  const originalFilename = resumeFilenameFor(input.vacancyTitle);
  const storagePath = `${input.candidateId}/${randomUUID()}-${originalFilename}`;

  const { error: uploadError } = await client.storage
    .from(RESUME_BUCKET)
    .upload(storagePath, bytes, { contentType: TAILORED_RESUME_MIME_TYPE, upsert: false });

  if (uploadError) {
    throw new TailoredResumeStorageError(`upload to ${storagePath} failed: ${uploadError.message}`);
  }

  const { data, error: insertError } = await client
    .from("resume_documents")
    .insert({
      candidate_id: input.candidateId,
      storage_path: storagePath,
      original_filename: originalFilename,
      mime_type: TAILORED_RESUME_MIME_TYPE,
      byte_size: bytes.byteLength,
      // What keeps this file off the candidate's Resumes page and out of the
      // base-resume lookup — see 20260917180000.
      kind: "tailored",
      // See 20260917190010: without this, a document prepared under one
      // setting and submitted after the candidate changed it could only be
      // described by the current preference, which may not be what produced it.
      optimization_level: input.optimizationLevel,
      // Task H3 provenance, PRD §16.3.
      output_sha256: outputSha256,
      facts_sha256: input.factsSha256 ?? null,
      template_version: input.templateVersion ?? null,
      model_version: input.modelVersion ?? null,
      ats_checks: atsChecks,
      ats_checked_at: new Date().toISOString(),
    })
    .select("id, storage_path, original_filename, mime_type, optimization_level")
    .single();

  if (insertError || !data) {
    throw new TailoredResumeStorageError(
      `the file uploaded to ${storagePath} but recording it failed: ${insertError?.message ?? "no row returned"}`,
    );
  }

  const row = data as {
    id: string;
    storage_path: string;
    original_filename: string;
    mime_type: string;
    optimization_level: ResumeOptimizationLevel | null;
  };

  return {
    documentId: row.id,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    // Read back from the row rather than echoing input.optimizationLevel: this
    // is what the database actually holds, so a mismatch would surface here
    // instead of being papered over by the value we hoped we wrote.
    optimizationLevel: isResumeOptimizationLevel(row.optimization_level) ? row.optimization_level : null,
  };
}

/**
 * Re-exported so a caller that only wants the base resume does not have to
 * reach into resumeGenerator.ts for it.
 */
export { loadBaseResumeDocument };
