import { describe, expect, it } from "vitest";
import { formatMailbox, parseMailboxAddress } from "./mailAddress.js";

describe("parseMailboxAddress", () => {
  it.each([
    ["jobs@acme.com", "jobs@acme.com"],
    ["Recruiting <jobs@acme.com>", "jobs@acme.com"],
    ['"Doe, Jane" <jobs@acme.com>', "jobs@acme.com"],
    ["  jobs@acme.com  ", "jobs@acme.com"],
    ["jane.doe+tag@gmail.com", "jane.doe+tag@gmail.com"],
  ])("reads %s", (header, expected) => {
    expect(parseMailboxAddress(header)).toBe(expected);
  });

  it("returns null for a list rather than choosing a recipient", () => {
    expect(parseMailboxAddress("a@x.com, b@y.com")).toBeNull();
    expect(parseMailboxAddress("a@x.com; b@y.com")).toBeNull();
  });

  it("returns null for anything that is not one address", () => {
    expect(parseMailboxAddress("Jane Doe")).toBeNull();
    expect(parseMailboxAddress("")).toBeNull();
    expect(parseMailboxAddress("   ")).toBeNull();
    expect(parseMailboxAddress(null)).toBeNull();
    expect(parseMailboxAddress(undefined)).toBeNull();
    expect(parseMailboxAddress("<>")).toBeNull();
    expect(parseMailboxAddress("jobs@acme")).toBeNull();
    expect(parseMailboxAddress("not an address at all")).toBeNull();
  });

  it("refuses a line break, which would inject a second header", () => {
    expect(parseMailboxAddress("jobs@acme.com\r\nBcc: evil@example.com")).toBeNull();
    expect(parseMailboxAddress("Recruiting <jobs@acme.com>\nBcc: evil@example.com")).toBeNull();
  });
});

describe("formatMailbox", () => {
  it("uses the bare address when there is no name", () => {
    expect(formatMailbox(null, "a@b.com")).toBe("a@b.com");
    expect(formatMailbox("   ", "a@b.com")).toBe("a@b.com");
  });

  it("writes Name <address> for an ordinary name", () => {
    expect(formatMailbox("Jane Doe", "a@b.com")).toBe("Jane Doe <a@b.com>");
  });

  it("quotes and escapes a name whose syntax would end the header early", () => {
    expect(formatMailbox('Jane "JD" Doe', "a@b.com")).toBe('"Jane \\"JD\\" Doe" <a@b.com>');
    expect(formatMailbox("Doe, Jane", "a@b.com")).toBe('"Doe, Jane" <a@b.com>');
    expect(formatMailbox("Jane <Admin>", "a@b.com")).toBe('"Jane <Admin>" <a@b.com>');
  });

  it("refuses a line break in a display name", () => {
    expect(() => formatMailbox("Jane\r\nBcc: evil@example.com", "a@b.com")).toThrow(/line break/);
  });
});
