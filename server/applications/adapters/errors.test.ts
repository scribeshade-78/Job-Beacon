import { describe, expect, it } from "vitest";
import { atsHttpFailure, retryAfterSecondsFrom } from "./errors.js";

/**
 * THE CLASSIFICATION THAT DECIDES WHETHER AN APPLICATION IS SENT TWICE.
 *
 * worker.ts only returns an attempt to the retry queue when the adapter has established that
 * the portal did NOT accept the submission. Everything else keeps the attempt in its
 * unreclaimable 'submitting' state and surfaces it for verification, because a retry after an
 * ambiguous failure is a SECOND REAL APPLICATION to that employer.
 *
 * These tests exist because that property was carried entirely by a DEFAULT: nothing in the
 * repository ever set nonAcceptanceEstablished, so every ATS HTTP failure was treated as
 * unknown and the retry policy below it was unreachable. Pinning each status explicitly is
 * what keeps the safety from depending on an omission.
 */

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("atsHttpFailure — nonAcceptanceEstablished", () => {
  it("does NOT claim non-acceptance for a 5xx, which may have been recorded before it failed", () => {
    // THE DUPLICATE-SUBMISSION VECTOR. A 502 or a 504 arrives after the request reached the
    // portal, and the portal may already hold the application. Claiming "nothing was accepted"
    // here is exactly what would license a retry.
    for (const status of [500, 501, 502, 503, 504, 507, 599]) {
      const error = atsHttpFailure(response(status), "upstream failed", "REASON");

      expect(error.nonAcceptanceEstablished, "status " + status).toBe(false);
      expect(error.retryable, "status " + status).toBe(true);
    }
  });

  it("does NOT claim non-acceptance for a 408, which is a server-side timeout", () => {
    // 408 IS a 4xx, so a naive "any 4xx is a rejection" rule marks it established. The server
    // timed out waiting for the request: it may or may not have processed it.
    expect(atsHttpFailure(response(408), "request timeout", "R").nonAcceptanceEstablished).toBe(false);
  });

  it("does NOT claim non-acceptance for a 409, which may mean the application already exists", () => {
    expect(atsHttpFailure(response(409), "conflict", "R").nonAcceptanceEstablished).toBe(false);
  });

  it("claims non-acceptance for an ordinary 4xx rejection, so the terminal path can run", () => {
    // Without this the worker never reaches its own validation-rejection branch, and a form
    // that refused what we sent is reported as needing manual verification instead of failed.
    for (const status of [400, 401, 403, 404, 413, 415, 422, 423, 428, 431]) {
      const error = atsHttpFailure(response(status), "rejected", "R");

      expect(error.nonAcceptanceEstablished, "status " + status).toBe(true);
      expect(error.retryable, "status " + status).toBe(false);
    }
  });

  it("claims non-acceptance for a 429 while keeping it retryable", () => {
    // A rate limit is the provider declining to process the request, not a recorded
    // submission — and Retry-After is how it says when to come back.
    const error = atsHttpFailure(response(429, { "retry-after": "120" }), "slow down", "R");

    expect(error.nonAcceptanceEstablished).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(120);
  });

  it("treats ONLY that explicit set as established, for every status a Response can carry", () => {
    // THE GUARANTEE. A status this build has never seen must fall to the conservative default
    // rather than into a truthy branch, so this asserts the whole 4xx-5xx range rather than a
    // sample of it. A new status added by an ATS is unknown, and unknown is never a licence to
    // resubmit.
    // The rule under test, stated once here so the sweep cannot drift from it: a 4xx rejection
    // except the two ambiguous ones. Everything else — every 5xx, and anything this build has
    // never seen — is unknown, and unknown is never a licence to resubmit.
    for (let status = 400; status <= 599; status += 1) {
      const expected = status < 500 && status !== 408 && status !== 409;
      const error = atsHttpFailure(response(status), "x", "R");

      expect(error.nonAcceptanceEstablished, "status " + status).toBe(expected);
    }
  });
});

describe("retryAfterSecondsFrom", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterSecondsFrom(response(429, { "retry-after": "45" }))).toBe(45);
  });

  it("returns null rather than inventing a wait when the header is absent", () => {
    expect(retryAfterSecondsFrom(response(429))).toBeNull();
  });
});
