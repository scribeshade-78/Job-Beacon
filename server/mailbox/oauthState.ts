import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * R6.1: Google's OAuth callback is a top-level browser navigation — it
 * carries no Authorization header, so requireAuth can't gate
 * /api/mailbox/oauth/callback the way every other candidate route is
 * gated. Standard fix: an authenticated route mints this signed,
 * short-lived `state` value (candidate_id + nonce + issuedAt, HMAC-signed),
 * Google echoes it back unmodified, and the callback verifies the
 * signature instead of a session — no server-side session store needed.
 *
 * THE SIGNATURE IS NOT THE WHOLE STORY, and it never was. A valid signature says the state was
 * MINTED by us; it says nothing about whether it has already been USED. The nonce is now returned
 * to the caller so it can be persisted in oauth_state and deleted on consumption — the row's
 * absence is what refuses a replay. A signature alone is a bearer token with a 10-minute life.
 *
 * PKCE IS DERIVED HERE for the same reason it is stored there: the verifier must survive from the
 * authorize redirect to the token exchange, and the nonce is already the thing that survives it.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  candidateId: string;
  nonce: string;
  issuedAt: number;
}

export interface CreatedOAuthState {
  /** The signed value Google echoes back. */
  state: string;
  /** Persisted so the callback can consume it — a replay finds no row. */
  nonce: string;
  /** Kept server-side; never sent to Google until the token exchange. */
  codeVerifier: string;
  /** Sent to Google in the authorize URL. */
  codeChallenge: string;
}

export interface VerifiedOAuthState {
  candidateId: string;
  /** The nonce the caller must consume. Verifying the signature is NOT enough to accept. */
  nonce: string;
}

function sign(secret: string, payloadB64: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * S256: code_challenge = BASE64URL(SHA256(ASCII(code_verifier))), per RFC 7636.
 *
 * Exported and pure so it can be tested against the specification directly rather than inferred
 * from a successful round trip — a challenge computed the wrong way still "works" against our own
 * verifier, and only Google can reject it.
 */
export function buildCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** A PKCE verifier: 32 random bytes, base64url — well inside RFC 7636's 43-128 character range. */
export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function createOAuthState(secret: string, candidateId: string): CreatedOAuthState {
  const nonce = randomBytes(16).toString("hex");
  const codeVerifier = createCodeVerifier();
  const payload: OAuthStatePayload = { candidateId, nonce, issuedAt: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  return {
    state: payloadB64 + "." + sign(secret, payloadB64),
    nonce,
    codeVerifier,
    codeChallenge: buildCodeChallenge(codeVerifier),
  };
}

/** Returns null for anything invalid, tampered, malformed, or expired — the caller treats every null the same way (reject the callback), so no reason code is distinguished. */
export function verifyOAuthState(secret: string, state: string): VerifiedOAuthState | null {
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

  if (typeof payload.nonce !== "string" || payload.nonce === "") {
    return null;
  }

  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    return null;
  }

  return { candidateId: payload.candidateId, nonce: payload.nonce };
}
