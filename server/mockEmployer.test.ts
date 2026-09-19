// @vitest-environment node
//
// Explicitly node, not the repo-wide jsdom default. This suite drives a real
// Express server over real HTTP with a real multipart body, and the parsing
// under test is Node's own — under jsdom the globals differ and
// Request.formData() cannot read a multipart body, which made every rejection
// assertion below pass for the wrong reason (a parse failure rather than the
// validation being tested).
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import {
  MOCK_EMPLOYER_PATH,
  MOCK_FAILURE_MARKER_ID,
  MOCK_FIELD_IDS,
  MOCK_SUCCESS_MARKER_ID,
  mountMockEmployer,
} from "./mockEmployer.js";

/**
 * These exercise the route over real HTTP with a real multipart body, because
 * the thing most likely to break here is the body parsing, and a mocked request
 * object would not exercise it at all.
 */

let server: Server | null = null;
let baseUrl = "";

async function start(): Promise<string> {
  const app = express();
  mountMockEmployer(app);

  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

function submission(overrides: { file?: Blob | null; fields?: Record<string, string> } = {}): FormData {
  const form = new FormData();
  const fields = overrides.fields ?? { fullName: "Sravani Kolapalli", email: "s@example.com", phone: "+1 555 0100" };

  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  const file = overrides.file === undefined ? new Blob(["%PDF-1.4"], { type: "application/pdf" }) : overrides.file;

  if (file) {
    form.append("resume", file, "resume-data-engineer.pdf");
  }

  return form;
}

describe("mock employer form", () => {
  it("serves a form with a required resume file input", async () => {
    await start();
    const html = await (await fetch(`${baseUrl}${MOCK_EMPLOYER_PATH}`)).text();

    expect(html).toContain(`id="${MOCK_FIELD_IDS.resume}"`);
    expect(html).toContain('type="file"');
    expect(html).toContain('enctype="multipart/form-data"');
  });
});

describe("mock employer submission", () => {
  it("accepts a complete multipart submission with an attached file", async () => {
    await start();
    const response = await fetch(`${baseUrl}${MOCK_EMPLOYER_PATH}`, { method: "POST", body: submission() });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`id="${MOCK_SUCCESS_MARKER_ID}"`);
  });

  it("rejects a submission with no file attached", async () => {
    await start();
    const response = await fetch(`${baseUrl}${MOCK_EMPLOYER_PATH}`, {
      method: "POST",
      body: submission({ file: null }),
    });
    const html = await response.text();

    // This is the check the adapter cannot make for itself: whether the file
    // actually arrived at the form.
    expect(response.status).toBe(400);
    expect(html).toContain(`id="${MOCK_FAILURE_MARKER_ID}"`);
    // The specific reason, not merely "something was rejected" — a body-parse
    // failure would also produce a 400 and would prove nothing.
    expect(html).toContain("Missing required file: resume");
  });

  it("rejects an empty file, which is not an attachment", async () => {
    await start();
    const response = await fetch(`${baseUrl}${MOCK_EMPLOYER_PATH}`, {
      method: "POST",
      body: submission({ file: new Blob([], { type: "application/pdf" }) }),
    });

    expect(response.status).toBe(400);
  });

  it("still rejects a submission that is missing a text field", async () => {
    await start();
    const response = await fetch(`${baseUrl}${MOCK_EMPLOYER_PATH}`, {
      method: "POST",
      body: submission({ fields: { fullName: "Sravani Kolapalli", phone: "+1 555 0100" } }),
    });
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(html).toContain("email");
  });

  it("rejects a non-multipart body rather than treating it as an empty form that passes", async () => {
    await start();
    const response = await fetch(`${baseUrl}${MOCK_EMPLOYER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "fullName=x&email=y&phone=z",
    });

    expect(response.status).toBe(400);
  });
});
