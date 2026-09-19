import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * R6.1: PRD §23's System Architecture table requires "Secret manager —
 * Source and employer credentials; no secrets in browser or [database]" —
 * see 20260820140000_mailbox_connections.sql's comment. No secret-manager
 * service (Vault/KMS/etc.) exists anywhere in this repo and standing one up
 * for a single-VPS deployment isn't justified yet, so this is the pragmatic
 * middle ground: envelope-encrypt the OAuth token bundle with a server-only
 * key (same trust tier as SUPABASE_SERVICE_ROLE_KEY — never VITE_-prefixed)
 * before it ever reaches mailbox_connections.secret_manager_key.
 *
 * ponytail: app-level AES-256-GCM instead of a real secret-manager service.
 * Upgrade path: move to Vault/Infisical/cloud KMS if per-secret rotation or
 * an external audit trail beyond this is ever required.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Reads a base64 AES-256-GCM key from a named environment variable.
 *
 * Extracted at Task H3, when employer ATS credentials became a second thing
 * needing envelope encryption under its own key. The validation is identical and
 * duplicating it would have meant two places for "must be exactly 32 bytes" to
 * be got right — and a weaker check in one of them would silently accept a
 * short key.
 */
export function readEncryptionKey(
  envVarName: string,
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env[envVarName];

  if (!raw) {
    throw new Error("Missing " + envVarName + " — required to encrypt/decrypt stored secrets.");
  }

  const key = Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(envVarName + " must decode (base64) to exactly 32 bytes for AES-256-GCM.");
  }

  return key;
}

export function readMailboxEncryptionKey(env: Record<string, string | undefined> = process.env): Buffer {
  return readEncryptionKey("MAILBOX_TOKEN_ENCRYPTION_KEY", env);
}

/**
 * Generic aliases. The two primitives below were named for their first caller,
 * not their only one: they are plain AES-256-GCM over (key, bytes) and know
 * nothing about mailboxes. Task H3's employer ATS credentials use them under a
 * different key, and calling encryptMailboxSecret from ATS code would have read
 * as though the two secrets shared a trust domain when they deliberately do not.
 */
export const encryptSecret = encryptMailboxSecret;
export const decryptSecret = decryptMailboxSecret;

/** iv || authTag || ciphertext, base64-encoded — a single opaque string fits mailbox_connections.secret_manager_key's existing `text` column with no schema change. */
export function encryptMailboxSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptMailboxSecret(key: Buffer, ciphertext: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
