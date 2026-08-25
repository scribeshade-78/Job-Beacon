import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * R6.1: Google's OAuth callback is a top-level browser navigation — it
 * carries no Authorization header, so requireAuth can't gate
 * /api/mailbox/oauth/callback the way every other candidate route is
 * gated. Standard fix: an authenticated route mints this signed,
 * short-lived `state` value (candidate_id + nonce + issuedAt, HMAC-signed),
 * Google echoes it back unmodified, and the callback verifies the
 * signature instead of a session — no server-side session store needed.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  candidateId: string;
  nonce: string;
  issuedAt: number;
}

function sign(secret: string, payloadB64: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function createOAuthState(secret: string, candidateId: string): string {
  const payload: OAuthStatePayload = {
    candidateId,
    nonce: randomBytes(16).toString("hex"),
    issuedAt: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

/** Returns null for anything invalid, tampered, malformed, or expired — the caller treats every null the same way (reject the callback), so no reason code is distinguished. */
export function verifyOAuthState(secret: string, state: string): { candidateId: string } | null {
  const parts = state.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payloadB64, signature] = parts;
  const expectedSignature = sign(secret, payloadB64);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  let payload: OAuthStatePayload;

  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.candidateId !== "string" || payload.candidateId === "" || typeof payload.issuedAt !== "number") {
    return null;
  }

  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    return null;
  }

  return { candidateId: payload.candidateId };
}
