// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { describingText } from "./fieldMatching";

/**
 * THE LABEL THAT IS NEITHER AN ANCESTOR NOR REFERENCED BY ID.
 *
 * The provided Workday structure puts a bare label as a SIBLING of its input:
 *
 *   <div data-automation-id="formField-legalNameSection_firstName">
 *     <label>First Name</label>
 *     <input data-automation-id="legalNameSection_firstName" />
 *   </div>
 *
 * That label has no for attribute, so label[for=id] cannot find it, and it is not an ancestor,
 * so closest("label") cannot either. The human-visible words "First Name" therefore never reach
 * describingText at all - the field is identifiable ONLY by its automation id. Anything the
 * candidate can read but we cannot is a field we may silently skip.
 */

beforeEach(() => {
  document.body.innerHTML = "";
});

function field(html: string): HTMLInputElement {
  document.body.innerHTML = html;
  const el = document.querySelector("input");
  if (!el) throw new Error("fixture has no input");
  return el;
}

describe("describingText: sibling labels with no for attribute", () => {
  it("collects the label of its own field wrapper", () => {
    const text = describingText(
      field(
        '<div data-automation-id="formField-legalNameSection_firstName">' +
          "<label>First Name</label>" +
          '<input data-automation-id="legalNameSection_firstName">' +
          "</div>",
      ),
    );

    expect(text).toContain("first name");
  });

  it("still puts the automation id first", () => {
    const text = describingText(
      field('<div><label>Phone Number</label><input data-automation-id="phoneNumber"></div>'),
    );

    expect(text.startsWith("phonenumber")).toBe(true);
    expect(text).toContain("phone number");
  });

  it("does NOT reach past a bounded number of ancestors", () => {
    // A label five levels up belongs to some other part of the page, and pulling it in is how a
    // filler matches the wrong field.
    const text = describingText(
      field(
        "<div><label>Date of Birth</label><div><div><div><div>" +
          '<input data-automation-id="unrelatedField">' +
          "</div></div></div></div></div>",
      ),
    );

    expect(text).not.toContain("date of birth");
  });

  it("does not duplicate a label that already wraps the input", () => {
    const text = describingText(
      field('<label>Email<input data-automation-id="email"></label>'),
    );

    expect(text.toLowerCase().split("email").length - 1).toBeGreaterThanOrEqual(1);
    expect(text).not.toMatch(/email.*email.*email/);
  });
});
