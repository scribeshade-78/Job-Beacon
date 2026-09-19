import { describe, expect, it, vi } from "vitest";
import {
  ATS_CREDENTIAL_KEY_ENV,
  AtsCredentialKeyError,
  loadAtsCredentialSecret,
  readAtsCredentialKey,
  setAtsCredentialActive,
  storeAtsCredential,
} from "./credentials.js";
import { decryptSecret, encryptSecret } from "../mailbox/tokenCrypto.js";

/**
 * The store's job is to keep employer keys encrypted and to return them ONLY for
 * an active credential. Both halves are asserted here: a store that leaked a
 * deactivated key would mean an employer could not actually withdraw
 * authorization by deactivating it.
 */

const KEY = Buffer.alloc(32, 9).toString("base64");
const ENV = { [ATS_CREDENTIAL_KEY_ENV]: KEY };

describe("readAtsCredentialKey", () => {
  it("reads a valid 32-byte key", () => {
    expect(readAtsCredentialKey(ENV)).toHaveLength(32);
  });

  it("refuses when unset rather than falling back to another key", () => {
    // Deliberately does NOT fall back to MAILBOX_TOKEN_ENCRYPTION_KEY: a leaked
    // mailbox token and a leaked employer key are different blast radii.
    expect(() => readAtsCredentialKey({})).toThrow(AtsCredentialKeyError);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => readAtsCredentialKey({ [ATS_CREDENTIAL_KEY_ENV]: Buffer.alloc(8, 1).toString("base64") })).toThrow(
      AtsCredentialKeyError,
    );
  });
});

function chain(value: { data: unknown; error: unknown }) {
  const node: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    node[method] = () => node;
  }
  node.single = async () => value;
  node.maybeSingle = async () => value;
  node.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  return node;
}

describe("storeAtsCredential", () => {
  it("stores ciphertext, never the plaintext, plus a four-character hint", async () => {
    const upsert = vi.fn((_payload: Record<string, unknown>) => chain({ data: { id: "cred-1" }, error: null }));
    const client = { from: () => ({ upsert }) } as never;

    await storeAtsCredential(client, { sourceCode: "greenhouse", employerKey: "acme", secret: "board-key-4f2a" }, ENV);

    const payload = upsert.mock.calls[0][0];
    expect(payload.secret_ciphertext).not.toContain("board-key-4f2a");
    expect(payload.key_hint).toBe("4f2a");
    expect(payload.is_active).toBe(true);
    // The hint must be useless on its own.
    expect(String(payload.key_hint)).toHaveLength(4);
    // And the ciphertext really is decryptable with the configured key.
    expect(decryptSecret(readAtsCredentialKey(ENV), String(payload.secret_ciphertext))).toBe("board-key-4f2a");
  });

  it("refuses an empty secret rather than storing a credential that cannot authenticate", async () => {
    const upsert = vi.fn();
    const client = { from: () => ({ upsert }) } as never;

    await expect(
      storeAtsCredential(client, { sourceCode: "lever", employerKey: "acme", secret: "   " }, ENV),
    ).rejects.toThrow(/empty ATS credential/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("loadAtsCredentialSecret", () => {
  it("returns the decrypted secret for an active credential", async () => {
    const ciphertext = decryptSecretTest();
    const client = {
      from: () => chain({ data: { id: "cred-1", secret_ciphertext: ciphertext }, error: null }),
    } as never;

    const loaded = await loadAtsCredentialSecret(client, "greenhouse", "acme", ENV);
    expect(loaded).toEqual({ id: "cred-1", secret: "board-key-4f2a" });
  });

  it("returns null when no row matches, rather than throwing", async () => {
    const client = { from: () => chain({ data: null, error: null }) } as never;
    expect(await loadAtsCredentialSecret(client, "greenhouse", "nobody", ENV)).toBeNull();
  });

  it("filters on is_active, so deactivating a key really withdraws it", async () => {
    const eq = vi.fn();
    const node: Record<string, unknown> = {};
    for (const method of ["select", "in", "order", "limit"]) {
      node[method] = () => node;
    }
    node.eq = (...args: unknown[]) => {
      eq(...args);
      return node;
    };
    node.maybeSingle = async () => ({ data: null, error: null });
    node.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve);

    await loadAtsCredentialSecret({ from: () => node } as never, "lever", "acme", ENV);

    expect(eq).toHaveBeenCalledWith("is_active", true);
  });
});

describe("setAtsCredentialActive", () => {
  it("writes the flag that the database trigger reads", async () => {
    const eq = vi.fn(() => chain({ data: null, error: null }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: () => ({ update }) } as never;

    await setAtsCredentialActive(client, "cred-1", false);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
  });
});

/** Encrypts the fixture secret with the same key the loader will use. */
function decryptSecretTest(): string {
  return encryptSecret(readAtsCredentialKey(ENV), "board-key-4f2a");
}
