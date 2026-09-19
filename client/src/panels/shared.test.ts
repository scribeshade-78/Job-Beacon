import { describe, expect, it } from "vitest";
import { safeVacancyHref } from "./shared";

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
