import { describe, expect, it } from "vitest";
import { appendAttemptId, safeVacancyHref } from "./shared";

/**
 * Task F — these tests did not exist before.
 *
 * safeVacancyHref is the only thing standing between a scraped
 * vacancies.authoritative_url (which has no scheme constraint in the database)
 * and an href attribute, and by Task F it was guarding eight call sites
 * including the moderator and admin consoles. It had no test at all, so the
 * guard could have been deleted, reordered, or weakened and every suite would
 * still have passed.
 */
describe("safeVacancyHref", () => {
  it("passes an http url through unchanged", () => {
    expect(safeVacancyHref("http://example.com/jobs/1")).toBe("http://example.com/jobs/1");
  });

  it("passes an https url through unchanged", () => {
    expect(safeVacancyHref("https://example.com/jobs/1?a=1#b")).toBe(
      "https://example.com/jobs/1?a=1#b",
    );
  });

  it("accepts an upper or mixed case scheme", () => {
    expect(safeVacancyHref("HTTPS://example.com/jobs/1")).toBe("HTTPS://example.com/jobs/1");
    expect(safeVacancyHref("HtTp://example.com/jobs/1")).toBe("HtTp://example.com/jobs/1");
  });

  it("neutralises a javascript url", () => {
    expect(safeVacancyHref("javascript:alert(1)")).toBe("#");
  });

  it("neutralises a javascript url hidden behind whitespace", () => {
    // A regex anchored with ^ and no trimming must still refuse this; a scheme
    // with leading whitespace is exactly how such a value gets through a naive
    // allowlist.
    expect(safeVacancyHref("  javascript:alert(1)")).toBe("#");
    expect(safeVacancyHref("\njavascript:alert(1)")).toBe("#");
    expect(safeVacancyHref("\tjavascript:alert(1)")).toBe("#");
  });

  it("neutralises other executable schemes", () => {
    expect(safeVacancyHref("data:text/html,<script>alert(1)</script>")).toBe("#");
    expect(safeVacancyHref("vbscript:msgbox(1)")).toBe("#");
    expect(safeVacancyHref("file:///C:/Windows/System32/calc.exe")).toBe("#");
    expect(safeVacancyHref("blob:https://example.com/uuid")).toBe("#");
  });

  it("neutralises a protocol-relative url", () => {
    // Resolves to the page's own scheme, so it is not obviously external.
    expect(safeVacancyHref("//evil.example.com/jobs/1")).toBe("#");
  });

  it("neutralises a scheme-less url", () => {
    expect(safeVacancyHref("example.com/jobs/1")).toBe("#");
    expect(safeVacancyHref("www.example.com/jobs/1")).toBe("#");
  });

  it("neutralises the empty string the server substitutes for a missing url", () => {
    // server/moderation/queue.ts and employer/appeals.ts both write
    // 'row.vacancies?.authoritative_url ?? ""', so "" is a value this
    // function genuinely receives rather than a hypothetical.
    expect(safeVacancyHref("")).toBe("#");
  });

  it("fails closed: anything not proven http(s) becomes a dead link", () => {
    // A "#" href does nothing when clicked, which is the safe direction. The
    // one cost is that a legitimate url with stray leading whitespace also
    // becomes "#" - losing a link is acceptable, executing a scraped string is
    // not.
    expect(safeVacancyHref(" https://example.com/jobs/1")).toBe("#");
  });
});

describe("appendAttemptId", () => {
  const ID = "a869cef4-5dce-4700-bb62-12505bd22d7e";

  it("appends the attempt id to a plain board URL", () => {
    expect(appendAttemptId("https://boards.greenhouse.io/acme/jobs/123", ID)).toBe(
      "https://boards.greenhouse.io/acme/jobs/123?jb_attempt_id=" + ID,
    );
  });

  it("PRESERVES an existing query string and the fragment", () => {
    const url = new URL(appendAttemptId("https://jobs.lever.co/acme/abc?utm_source=x#apply", ID));
    expect(url.searchParams.get("utm_source")).toBe("x");
    expect(url.searchParams.get("jb_attempt_id")).toBe(ID);
    expect(url.hash).toBe("#apply");
  });

  it("leaves a REFUSED url refused rather than decorating it", () => {
    expect(appendAttemptId("#", ID)).toBe("#");
  });

  it("does nothing without an attempt id", () => {
    expect(appendAttemptId("https://example.com/j", undefined)).toBe("https://example.com/j");
    expect(appendAttemptId("https://example.com/j", "")).toBe("https://example.com/j");
  });

  it("stays composable with safeVacancyHref - a dangerous URL never gets a parameter", () => {
    expect(appendAttemptId(safeVacancyHref("javascript:alert(1)"), ID)).toBe("#");
    expect(appendAttemptId(safeVacancyHref("https://x.test/j"), ID)).toContain("jb_attempt_id=" + ID);
  });

  it("encodes the id so it cannot break out of the query string", () => {
    const out = appendAttemptId("https://example.com/j", "a&b=c d");
    expect(out).not.toContain("a&b=c d");
    expect(new URL(out).searchParams.get("jb_attempt_id")).toBe("a&b=c d");
  });
});
