import { describe, expect, it } from "vitest";
import { decryptMailboxSecret, encryptMailboxSecret, readMailboxEncryptionKey } from "./tokenCrypto.js";

const KEY = Buffer.alloc(32, 7);

describe("readMailboxEncryptionKey", () => {
  it("decodes a valid base64 32-byte key", () => {
    const key = readMailboxEncryptionKey({ MAILBOX_TOKEN_ENCRYPTION_KEY: KEY.toString("base64") });
    expect(key).toEqual(KEY);
  });

  it("throws when unset", () => {
    expect(() => readMailboxEncryptionKey({})).toThrow(/MAILBOX_TOKEN_ENCRYPTION_KEY/);
  });

  it("throws when it doesn't decode to 32 bytes", () => {
    expect(() => readMailboxEncryptionKey({ MAILBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
  });
});

describe("encryptMailboxSecret / decryptMailboxSecret", () => {
  it("round-trips plaintext", () => {
    const plaintext = JSON.stringify({ accessToken: "at", refreshToken: "rt", expiresAt: 123 });
    const ciphertext = encryptMailboxSecret(KEY, plaintext);

    expect(ciphertext).not.toContain("refreshToken");
    expect(decryptMailboxSecret(KEY, ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const plaintext = "same-plaintext";
    expect(encryptMailboxSecret(KEY, plaintext)).not.toBe(encryptMailboxSecret(KEY, plaintext));
  });

  it("fails to decrypt with the wrong key", () => {
    const ciphertext = encryptMailboxSecret(KEY, "secret");
    const wrongKey = Buffer.alloc(32, 9);
    expect(() => decryptMailboxSecret(wrongKey, ciphertext)).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const ciphertext = encryptMailboxSecret(KEY, "secret");
    const raw = Buffer.from(ciphertext, "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(() => decryptMailboxSecret(KEY, raw.toString("base64"))).toThrow();
  });
});
