// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { AUTOMATION_ID_ATTRIBUTE, automationIdOf, describingText } from "./fieldMatching";

/**
 * THE FILLER'S FIRST TESTS, for the surface where we have no fallback.
 *
 * content.ts is a content script that exports nothing and had no test file, so the code that
 * fills a Workday application - the one site where the extension is the sole executor - was
 * unverified. These cover the extracted, pure half.
 *
 * THE VALUES BELOW ARE SYNTHETIC. They pin the MECHANISM (a deliberate attribute outranks
 * inferred text), not Workday's real DOM. The real data-automation-id values get pinned from a
 * captured Workday fixture in the step-machine work, which is the only honest way to assert
 * them.
 */

function field(html: string): HTMLInputElement {
  document.body.innerHTML = html;
  const el = document.querySelector("input");
  if (!el) throw new Error("fixture has no input");
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("automationIdOf", () => {
  it("reads the site's own automation hook", () => {
    expect(automationIdOf(field('<input data-automation-id="firstName">'))).toBe("firstname");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(automationIdOf(field('<input data-automation-id="  FirstName  ">'))).toBe("firstname");
  });

  it("is empty when the site declares nothing, so callers can fall through", () => {
    expect(automationIdOf(field('<input id="fn" name="first_name">'))).toBe("");
  });

  it("uses Workday's attribute name and no invented alias", () => {
    expect(AUTOMATION_ID_ATTRIBUTE).toBe("data-automation-id");
  });
});

describe("describingText", () => {
  it("PUTS THE AUTOMATION ID FIRST, ahead of every inferred signal", () => {
    // This is the whole point of the ordering. The attribute is the one part of the string the
    // site chose deliberately, so a match against it is unambiguous - and a regex anchored to
    // the start of the blob reaches it without wading through concatenated prose.
    const text = describingText(
      field('<input data-automation-id="firstName" id="input-7f3a" name="q1" placeholder="Type here" aria-label="Given name">'),
    );

    expect(text.startsWith("firstname")).toBe(true);
  });

  it("still collects the weaker signals behind it", () => {
    const text = describingText(field('<input data-automation-id="firstName" name="legalName" aria-label="Given name">'));

    expect(text).toContain("legalname");
    expect(text).toContain("given name");
  });

  it("falls back to id, name, placeholder and aria-label with no automation id", () => {
    const text = describingText(
      field('<input id="candidate_email" name="emailAddress" placeholder="you@example.com" aria-label="Email address">'),
    );

    expect(text).toContain("candidate_email");
    expect(text).toContain("emailaddress");
    expect(text).toContain("you@example.com");
    expect(text).toContain("email address");
  });

  it("still resolves a label[for] element when there is no automation id", () => {
    const el = field('<input id="email-field"><label for="email-field">Email</label>');

    expect(describingText(el)).toContain("email");
  });

  it("resolves label[for] against the element's OWN document, not a global", () => {
    // A content script runs in a page whose document is not necessarily the module's global one,
    // and a test harness can swap it. Reading through ownerDocument is what makes that safe.
    const el = field('<input id="phone-field"><label for="phone-field">Phone number</label>');

    expect(describingText(el)).toContain("phone number");
  });

  it("does NOT let a noisy wrapping container hide the automation id", () => {
    // The Workday shape: the step container carries instructions alongside the field. The id is
    // still first, so a pattern aimed at it cannot be confused by the prose that follows.
    const el = field(
      '<label>Please enter your legal name exactly as it appears on your government ID. ' +
        '<input data-automation-id="legalNameFirstName"></label>',
    );

    expect(describingText(el).startsWith("legalnamefirstname")).toBe(true);
  });

  it("returns an empty string rather than throwing on a field with no signals", () => {
    expect(describingText(field("<input>"))).toBe("");
  });
});
