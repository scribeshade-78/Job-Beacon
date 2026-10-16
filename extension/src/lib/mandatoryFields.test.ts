// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILLABLE_SELECTOR,
  findEmptyMandatoryFields,
  isFillableElement,
  isMandatory,
  isVisible,
} from "./mandatoryFields";

const DROPDOWN = '<button data-automation-id="promptIcon" aria-haspopup="listbox">Mobile</button>';

beforeEach(() => {
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0,
  } as unknown as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("button-based dropdowns are visible to the filler", () => {
  it("selects an ARIA listbox trigger, which is a BUTTON and not an input", () => {
    document.body.innerHTML = DROPDOWN;
    const trigger = document.querySelector("button")!;

    expect(document.querySelectorAll(FILLABLE_SELECTOR).length).toBe(1);
    expect(isFillableElement(trigger)).toBe(true);
  });

  it("selects a role=combobox trigger", () => {
    document.body.innerHTML = '<div role="combobox" aria-expanded="false">Select One</div>';

    expect(document.querySelectorAll(FILLABLE_SELECTOR).length).toBe(1);
  });

  it("does NOT select an ordinary button - only the ARIA dropdown contract counts", () => {
    document.body.innerHTML = '<button>Save and Continue</button>';

    expect(document.querySelectorAll(FILLABLE_SELECTOR).length).toBe(0);
  });

  it("never treats a checkbox, radio or file input as text-fillable", () => {
    document.body.innerHTML =
      '<input type="checkbox"><input type="radio"><input type="file"><input type="hidden"><input type="text">';

    const fillable = Array.from(document.querySelectorAll("input")).filter(isFillableElement);
    expect(fillable.length).toBe(1);
    expect((fillable[0] as HTMLInputElement).type).toBe("text");
  });
});

describe("mandatory detection", () => {
  it("reads the required attribute and the ARIA equivalent", () => {
    document.body.innerHTML =
      '<input id="a" required><input id="b" aria-required="true"><input id="c" aria-required="false">';

    expect(isMandatory(document.getElementById("a")!)).toBe(true);
    expect(isMandatory(document.getElementById("b")!)).toBe(true);
    expect(isMandatory(document.getElementById("c")!)).toBe(false);
  });
});

describe("findEmptyMandatoryFields - the safety net", () => {
  it("reports a visible, required, empty field", () => {
    document.body.innerHTML = '<input required value="">';

    expect(findEmptyMandatoryFields(document).length).toBe(1);
  });

  it("IGNORES a required field that already has a value", () => {
    document.body.innerHTML = '<input required value="Priya">';

    expect(findEmptyMandatoryFields(document)).toEqual([]);
  });

  it("ignores a required field that is hidden", () => {
    // A hidden field cannot be seen, cannot be filled, and would otherwise halt every run.
    document.body.innerHTML = '<input required hidden><input required style="display: none;">';

    expect(findEmptyMandatoryFields(document)).toEqual([]);
  });

  it("ignores a required field inside an aria-hidden subtree", () => {
    document.body.innerHTML = '<div aria-hidden="true"><input required></div>';

    expect(findEmptyMandatoryFields(document)).toEqual([]);
  });

  it("ignores an optional field and a whitespace-only value is still empty", () => {
    document.body.innerHTML = '<input value="   "><input required value="   ">';

    expect(findEmptyMandatoryFields(document).length).toBe(1);
  });

  it("NEVER reports a dropdown, because emptiness there is not defined", () => {
    // The deliberate limit. Reading "Mobile" or "Select One" as empty is a guess, and a wrong
    // guess halts a step that is actually complete - so a dropdown is never reported here.
    document.body.innerHTML = DROPDOWN + '<div role="combobox" required aria-expanded="false">Select One</div>';

    expect(findEmptyMandatoryFields(document)).toEqual([]);
  });

  it("scopes the scan to the root it is given", () => {
    document.body.innerHTML =
      '<div id="step-a"><input required></div><div id="step-b"><input required></div>';

    expect(findEmptyMandatoryFields(document.getElementById("step-b")!).length).toBe(1);
  });
});
