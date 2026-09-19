import express, { type Express, type Request, type Response } from "express";

/**
 * Mini-Phase 8 — the local fixture submission target.
 *
 * A stand-in employer application form, served by this same Express process at
 * /mock-employer/apply, so the first submission adapter has somewhere to
 * submit that is not a third-party job board. It submits nothing anywhere: the
 * POST handler validates the three fields and renders a success page. No data
 * is persisted, logged, or forwarded.
 *
 * WHY A FIXTURE AT ALL. Neither source with real data can be a submission
 * target — Jooble is an aggregator with no application channel, and USAJOBS
 * needs an account login (its own HowToApply text on the seeded postings says
 * "This post is for viewing purposes only"), and both carry
 * automated_application_allowed = false with an unreviewed ToU. See
 * 20260917170000_local_fixture_source.sql.
 *
 * The element ids below are contract, not decoration: the adapter targets them
 * by id, so renaming one here without updating the adapter is what makes the
 * "changed selector" failure path fire — which is exactly the failure mode a
 * real portal adapter has to survive, and the reason this target is worth
 * having.
 */

export const MOCK_EMPLOYER_PATH = "/mock-employer/apply";

/** Present only on the success page — the adapter's assertion that it worked. */
export const MOCK_SUCCESS_MARKER_ID = "application-received";
export const MOCK_FAILURE_MARKER_ID = "application-rejected";

export const MOCK_FIELD_IDS = {
  fullName: "candidate-full-name",
  email: "candidate-email",
  phone: "candidate-phone",
  resume: "candidate-resume",
  submit: "submit-application",
} as const;

/**
 * Mounted in every environment except production, and additionally
 * switchable-off via DISABLE_MOCK_EMPLOYER so a deployment that is not
 * NODE_ENV=production for some reason does not quietly serve a fake employer.
 */
export function isMockEmployerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.DISABLE_MOCK_EMPLOYER !== "true";
}

const FORM_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Mock Employer — Apply</title></head>
  <body>
    <h1>Apply for this role</h1>
    <form method="post" action="${MOCK_EMPLOYER_PATH}" enctype="multipart/form-data">
      <label for="${MOCK_FIELD_IDS.fullName}">Full name</label>
      <input id="${MOCK_FIELD_IDS.fullName}" name="fullName" type="text" required />

      <label for="${MOCK_FIELD_IDS.email}">Email</label>
      <input id="${MOCK_FIELD_IDS.email}" name="email" type="email" required />

      <label for="${MOCK_FIELD_IDS.phone}">Phone</label>
      <input id="${MOCK_FIELD_IDS.phone}" name="phone" type="tel" required />

      <label for="${MOCK_FIELD_IDS.resume}">Resume</label>
      <input id="${MOCK_FIELD_IDS.resume}" name="resume" type="file" accept="application/pdf" required />

      <button id="${MOCK_FIELD_IDS.submit}" type="submit">Submit application</button>
    </form>
  </body>
</html>`;

function successHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Application received</title></head>
  <body>
    <h1 id="${MOCK_SUCCESS_MARKER_ID}">Application received</h1>
    <p>This is a local fixture. Nothing was sent anywhere.</p>
  </body>
</html>`;
}

function failureHtml(reason: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Application rejected</title></head>
  <body>
    <h1 id="${MOCK_FAILURE_MARKER_ID}">Application rejected</h1>
    <p>${reason}</p>
  </body>
</html>`;
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parses the submitted form without a multipart dependency.
 *
 * Node's own fetch primitives can read a multipart body: constructing a Request
 * over the raw bytes and calling formData() runs undici's parser, which is the
 * same code path a real handler would use. Hand-rolling a boundary parser (or
 * adding multer to a dev fixture) would both be worse than using what the
 * runtime already ships.
 */
async function readMultipartForm(
  request: Request,
): Promise<{ fields: Record<string, string>; resume: { filename: string; byteSize: number } | null }> {
  const contentType = request.headers["content-type"];

  if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    return { fields: {}, resume: null };
  }

  const form = await new Request("http://127.0.0.1/", {
    method: "POST",
    headers: { "content-type": contentType },
    body: request.body as Buffer,
  }).formData();

  const fields: Record<string, string> = {};
  let resume: { filename: string; byteSize: number } | null = null;

  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields[key] = value;
      continue;
    }

    // A File entry. Only its name and size are kept — a fixture that is not
    // allowed to persist anything must not hold the candidate's document in
    // memory longer than the request.
    if (key === "resume") {
      resume = { filename: value.name, byteSize: value.size };
    }
  }

  return { fields, resume };
}

export function mountMockEmployer(app: Express): void {
  app.get(MOCK_EMPLOYER_PATH, (_request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    response.status(200).type("html").send(FORM_HTML);
  });

  app.post(
    MOCK_EMPLOYER_PATH,
    // raw, not urlencoded: the form is multipart because it carries a file, and
    // express.urlencoded would leave the body unparsed and every field empty.
    express.raw({ type: "multipart/form-data", limit: "10mb" }),
    async (request: Request, response: Response) => {
      response.set("Cache-Control", "no-store");

      let fields: Record<string, string>;
      let resume: { filename: string; byteSize: number } | null;

      try {
        ({ fields, resume } = await readMultipartForm(request));
      } catch {
        response.status(400).type("html").send(failureHtml("Could not read the submitted form."));
        return;
      }

      const missing = ["fullName", "email", "phone"].filter((field) => requireString(fields[field]) === "");

      // A real portal rejects an incomplete form; the fixture does the same, so
      // an adapter that fails to map a field fails here rather than appearing
      // to succeed. Nothing about the submitted values is logged.
      if (missing.length > 0) {
        response.status(400).type("html").send(failureHtml(`Missing required field(s): ${missing.join(", ")}.`));
        return;
      }

      // The resume is checked server-side, not merely asserted by the adapter
      // after it fills the input: an attachment that never reached the form is
      // precisely the failure this route exists to catch, and only the server
      // can see whether it arrived.
      if (!resume || resume.byteSize === 0) {
        response.status(400).type("html").send(failureHtml("Missing required file: resume."));
        return;
      }

      response.status(200).type("html").send(successHtml());
    },
  );
}
