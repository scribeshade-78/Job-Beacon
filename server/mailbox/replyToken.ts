import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CRYPTOGRAPHIC REPLY TOKEN — the provenance signal that cannot be spoofed.
 *
 * WHAT PROBLEM IT SOLVES. Everything the matcher otherwise scores is public or guessable: a
 * company name, a role title and a job id are all on the job board, and a From header is
 * whatever the sender typed. auth_results narrows that gap but is a provider's opinion, and a
 * provider that sends no header leaves us at UNKNOWN. This token is different in kind: it is
 * unguessable without the signing secret, it names the exact application, and it arrives in the
 * RECIPIENT of the reply rather than in anything the sender chooses.
 *
 * HOW IT TRAVELS (topology A — the candidate's own mailbox).
 *
 *   outbound Reply-To:  jane.doe+<TOKEN>@gmail.com
 *   recruiter replies:  To: jane.doe+<TOKEN>@gmail.com
 *   we already poll that mailbox, so the token comes back for free.
 *
 * Gmail delivers `local+anything` to `local`, so no MX, webhook or new domain is needed. If a
 * provider strips the `+`, the address degrades to the plain mailbox, the token is simply
 * absent, and the hardened heuristics take over — the feature is additive by construction.
 *
 * WHY THE TOKEN IS THE MAC AND NOT A PAYLOAD-PLUS-MAC.
 *
 * The obvious layout embeds the attempt UUID and appends a signature. It does not fit. The
 * local part is capped at 64 octets (RFC 5321 §4.5.3.1.1) and topology A spends that budget on
 * the candidate's own address first:
 *
 *   version(1) + uuid(16) + mac(16) = 33 bytes = 53 Crockford chars
 *   candidate local part <= 64 - 1 - 53 = 10 chars
 *
 * Ten characters excludes most real addresses, so a token that carried the UUID would be
 * unusable for most candidates. Instead the token IS HMAC(attempt id): 1 version byte + a
 * truncated 96-bit MAC = 13 bytes = 21 chars, leaving 42 for the candidate's local part. The
 * attempt id is recovered by recomputing the MAC per candidate attempt — the matcher already
 * holds those, so resolution costs no query and no extra column.
 *
 * SECURITY NOTE, STATED PLAINLY. The token is a routing identifier, not a sender authentication.
 * Anyone who learns the address can mail it. A hard SPF/DKIM failure must therefore still route
 * the message to review — "fail wins" is unchanged by this module.
 */

/**
 * Crockford base32. Chosen over base64url because an email local part can be case-folded by any
 * MTA along the way: base64url's `A` becoming `a` would silently invalidate the MAC, and that is
 * a failure with no error, no log and no way to distinguish it from a forged token. Crockford is
 * decoded case-insensitively and its alphabet excludes I, L, O and U, so no character in the
 * token can be confused with another at the transport layer.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford's decoder folds I/L to 1 and O to 0, and ignores case. */
const ALPHABET_INDEX: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let index = 0; index < ALPHABET.length; index += 1) {
    map[ALPHABET[index]!] = index;
  }
  map.I = 1;
  map.L = 1;
  map.O = 0;
  return map;
})();

/** v1 = the MAC-only layout above. A future layout gets its own version rather than a new shape. */
export const REPLY_TOKEN_VERSION = 1;

/** 96 bits. The MAC is the whole credential, so it is not a formality — see the note above. */
export const REPLY_TOKEN_MAC_BYTES = 12;

/** version byte + MAC. 13 bytes is exactly 21 Crockford characters. */
export const REPLY_TOKEN_LENGTH = 21;

/** RFC 5321 §4.5.3.1.1 — the hard ceiling on everything before the `@`. */
export const REPLY_TOKEN_MAX_LOCAL_PART = 64;

/**
 * Domain separation. The same secret must never be usable to mint a MAC for another protocol,
 * and the version is inside the MAC input so a token cannot be relabelled from v1 to v2.
 */
const MAC_CONTEXT = "jobbeacon:reply-token:v1:";

const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/** Fixed-width Crockford encoding; the final character is zero-padded when the bit count is not a multiple of 5. */
function encodeCrockford(bytes: Buffer, characters: number): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let position = 0; position < characters; position += 1) {
    while (bits < 5) {
      buffer = (buffer << 8) | (index < bytes.length ? bytes[index++]! : 0);
      bits += 8;
    }

    output += ALPHABET[(buffer >> (bits - 5)) & 31];
    bits -= 5;
  }

  return output;
}

/** Returns null for any character outside the alphabet — including the `+`, `-` and `.` that transport may add. */
function decodeCrockford(text: string): Buffer | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of text) {
    const value = ALPHABET_INDEX[character.toUpperCase()];

    if (value === undefined) {
      return null;
    }

    buffer = (buffer << 5) | value;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Canonical UUID bytes, or null.
 *
 * Parsed rather than hashed as text so the same attempt always signs under one representation:
 * `AB12...` and `ab12...` and a hyphenated spelling all normalise to identical bytes, and an id
 * that is not a UUID is refused instead of quietly producing a token nothing can resolve.
 */
function attemptIdBytes(attemptId: string): Buffer | null {
  const hex = attemptId.trim().toLowerCase().replace(/-/g, "");

  if (!UUID_HEX_PATTERN.test(hex)) {
    return null;
  }

  return Buffer.from(hex, "hex");
}

function macFor(attemptId: string, secret: Buffer): Buffer | null {
  const bytes = attemptIdBytes(attemptId);

  if (!bytes) {
    return null;
  }

  return createHmac("sha256", secret)
    .update(MAC_CONTEXT, "utf8")
    .update(bytes)
    .digest()
    .subarray(0, REPLY_TOKEN_MAC_BYTES);
}

/**
 * Mints the plus-address for one application attempt.
 *
 * RETURNS NULL WHEN IT CANNOT FIT, rather than emitting an address whose local part exceeds 64
 * octets. A caller that gets null must send the plain Reply-To: a token the transport may reject
 * is worse than no token at all, because the failure is a bounced reply.
 *
 * Throws on a malformed attempt id — that is a programming error, not a runtime condition.
 */
export function mintReplyAddress(
  attemptId: string,
  options: { secret: Buffer; baseAddress: string },
): string | null {
  const mac = macFor(attemptId, options.secret);

  if (!mac) {
    throw new Error(`mintReplyAddress requires an application_attempts UUID, received: ${attemptId}`);
  }

  const at = options.baseAddress.lastIndexOf("@");
  const local = at > 0 ? options.baseAddress.slice(0, at).trim() : "";
  const domain = at > 0 ? options.baseAddress.slice(at + 1).trim() : "";

  if (!local || !domain) {
    throw new Error(`mintReplyAddress requires a bare email address, received: ${options.baseAddress}`);
  }

  const token = encodeCrockford(
    Buffer.concat([Buffer.from([REPLY_TOKEN_VERSION]), mac]),
    REPLY_TOKEN_LENGTH,
  );

  // The token is APPENDED to whatever the candidate's local part already is, so an address that
  // is already plus-addressed (jane+work@) still keeps the token as its last segment.
  if (local.length + 1 + token.length > REPLY_TOKEN_MAX_LOCAL_PART) {
    return null;
  }

  return `${local}+${token}@${domain}`;
}

/**
 * Verifies the reply token carried by a recipient header and resolves it to one of the supplied
 * attempts.
 *
 * TAKES THE CANDIDATE'S ATTEMPTS, NOT A DATABASE. Resolution is "which of this candidate's
 * attempts does this MAC belong to", and the caller already has that list — so a token for
 * another candidate's attempt simply resolves to nothing rather than requiring an ownership
 * check. An empty list means an unattributable reply, never a crash.
 *
 * Everything about a malformed header is a null return: absent, empty, no plus-address, wrong
 * length, character outside the alphabet, unknown version, MAC mismatch. A corrupt token must
 * never fail ingestion, and a token that cannot be verified must never be trusted.
 */
export function verifyReplyToken(
  recipientHeader: string | null | undefined,
  attemptIds: readonly string[],
  secret: Buffer,
): { attemptId: string; version: number } | null {
  if (!recipientHeader) {
    return null;
  }

  for (const address of addressesIn(recipientHeader)) {
    const token = tokenOf(address);

    if (!token) {
      continue;
    }

    const decoded = decodeCrockford(token);

    if (!decoded || decoded.length !== 1 + REPLY_TOKEN_MAC_BYTES) {
      continue;
    }

    const version = decoded[0]!;

    if (version !== REPLY_TOKEN_VERSION) {
      continue;
    }

    const presented = decoded.subarray(1);

    for (const attemptId of attemptIds) {
      const expected = macFor(attemptId, secret);

      if (!expected) {
        continue;
      }

      // Constant-time, and length-checked first because timingSafeEqual throws on a mismatch.
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
        return { attemptId, version };
      }
    }
  }

  return null;
}

/** Every address in a header, including ones inside angle brackets; display names and quoted text are ignored. */
function addressesIn(header: string): string[] {
  return header.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? [];
}

/** The token is the last `+` segment of the local part, so an already-plus-addressed mailbox still works. */
function tokenOf(address: string): string | null {
  const at = address.lastIndexOf("@");

  if (at <= 0) {
    return null;
  }

  const local = address.slice(0, at);
  const plus = local.lastIndexOf("+");

  if (plus < 0) {
    return null;
  }

  const token = local.slice(plus + 1);

  return token.length === REPLY_TOKEN_LENGTH ? token : null;
}
