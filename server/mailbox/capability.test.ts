import { describe, expect, it } from "vitest";
import { describeMailboxCapability, readMailboxCapability } from "./capability.js";

/**
 * The behaviour under test is the one that keeps an optional integration from
 * becoming an outage: these readers throw, and this module must turn that throw
 * into a reported reason without letting it propagate.
 */

const KEY = Buffer.alloc(32, 3).toString("base64");

const COMPLETE = {
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://app.test/callback",
  MAILBOX_TOKEN_ENCRYPTION_KEY: KEY,
};

describe("readMailboxCapability", () => {
  it("enables both Google subsystems when everything is configured", () => {
    const capability = readMailboxCapability(COMPLETE);

    expect(capability.googleOAuth.enabled).toBe(true);
    expect(capability.tokenEncryption.enabled).toBe(true);
    expect(capability.googleMail.enabled).toBe(true);
    expect(capability.googleCalendar.enabled).toBe(true);
    expect(capability.googleMail.reason).toBeNull();
  });

  it("never throws on an entirely empty environment", () => {
    expect(() => readMailboxCapability({})).not.toThrow();
    const capability = readMailboxCapability({});
    expect(capability.googleMail.enabled).toBe(false);
  });

  it("names the OAuth variables when the client is missing", () => {
    const capability = readMailboxCapability({ MAILBOX_TOKEN_ENCRYPTION_KEY: KEY });

    expect(capability.googleOAuth.enabled).toBe(false);
    expect(capability.tokenEncryption.enabled).toBe(true);
    expect(capability.googleMail.reason).toContain("GOOGLE_OAUTH_CLIENT_ID");
  });

  it("names the encryption key when only that is missing", () => {
    const capability = readMailboxCapability({
      GOOGLE_OAUTH_CLIENT_ID: "client",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://app.test/callback",
    });

    expect(capability.googleMail.enabled).toBe(false);
    expect(capability.googleMail.reason).toContain("MAILBOX_TOKEN_ENCRYPTION_KEY");
  });

  it("rejects a key that is the wrong length rather than accepting a weak one", () => {
    const capability = readMailboxCapability({ ...COMPLETE, MAILBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(8, 1).toString("base64") });

    expect(capability.tokenEncryption.enabled).toBe(false);
    expect(capability.googleMail.enabled).toBe(false);
  });

  it("reports the FIRST missing prerequisite, not both at once", () => {
    const capability = readMailboxCapability({});
    expect(capability.googleMail.reason).toContain("GOOGLE_OAUTH");
  });
});

describe("describeMailboxCapability", () => {
  it("says nothing when everything is configured", () => {
    expect(describeMailboxCapability(readMailboxCapability(COMPLETE))).toEqual([]);
  });

  it("explains what is disabled, why, and what still runs", () => {
    const lines = describeMailboxCapability(readMailboxCapability({}));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DISABLED");
    expect(lines[0]).toContain("GOOGLE_OAUTH_CLIENT_ID");
    // The operator needs to know the rest of the scheduler is unaffected.
    expect(lines[0]).toContain("classification and application matching still run");
  });
});
