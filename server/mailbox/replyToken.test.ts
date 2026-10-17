import { describe, expect, it } from "vitest";
import {
  mintReplyAddress,
  REPLY_TOKEN_LENGTH,
  REPLY_TOKEN_MAX_LOCAL_PART,
  verifyReplyToken,
} from "./replyToken.js";

const SECRET = Buffer.alloc(32, 7);
const OTHER_SECRET = Buffer.alloc(32, 8);

const ATTEMPT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SECOND_ATTEMPT = "9c858901-8a57-4791-81fe-4c455b099bc9";
const BASE = "jane.doe@gmail.com";

function localPartOf(address: string): string {
  return address.slice(0, address.lastIndexOf("@"));
}

function tokenOf(address: string): string {
  const local = localPartOf(address);
  return local.slice(local.lastIndexOf("+") + 1);
}

function mint(attemptId = ATTEMPT, baseAddress = BASE, secret = SECRET): string {
  const address = mintReplyAddress(attemptId, { secret, baseAddress });

  if (!address) {
    throw new Error("expected the address to fit");
  }

  return address;
}

describe("mintReplyAddress / verifyReplyToken", () => {
  it("round-trips an address back to the attempt it was minted for", () => {
    const address = mint();

    expect(verifyReplyToken(`To: ${address}`, [ATTEMPT], SECRET)).toEqual({
      attemptId: ATTEMPT,
      version: 1,
    });
  });

  it("resolves to the right attempt among several, so it is an identifier and not a match", () => {
    const address = mint(SECOND_ATTEMPT);

    expect(verifyReplyToken(address, [ATTEMPT, SECOND_ATTEMPT], SECRET)?.attemptId).toBe(SECOND_ATTEMPT);
  });

  it("returns null for an attempt that is not in the candidate's list, which is how ownership is enforced", () => {
    const address = mint(ATTEMPT);

    expect(verifyReplyToken(address, [SECOND_ATTEMPT], SECRET)).toBeNull();
  });

  it("is deterministic, so the same application always shows the same reply address", () => {
    expect(mint()).toBe(mint());
  });

  it("keeps the token as the LAST plus segment of an already plus-addressed mailbox", () => {
    const address = mint(ATTEMPT, "jane+work@gmail.com");

    expect(localPartOf(address).startsWith("jane+work+")).toBe(true);
    expect(verifyReplyToken(address, [ATTEMPT], SECRET)?.attemptId).toBe(ATTEMPT);
  });

  it("normalises the attempt id, so a hyphenless or upper-case UUID signs identically", () => {
    const canonical = mint(ATTEMPT);
    const odd = mint(ATTEMPT.toUpperCase().replace(/-/g, ""));

    expect(odd).toBe(canonical);
    expect(verifyReplyToken(canonical, [ATTEMPT.toUpperCase()], SECRET)?.attemptId).toBe(ATTEMPT.toUpperCase());
  });

  it("throws on a malformed attempt id instead of minting an address nothing can resolve", () => {
    expect(() => mintReplyAddress("not-a-uuid", { secret: SECRET, baseAddress: BASE })).toThrow(
      /application_attempts UUID/,
    );
  });
});

describe("transport survival", () => {
  it("emits only Crockford characters, so no plus, dot, hyphen or underscore reaches the transport", () => {
    const token = tokenOf(mint());

    // Crockford excludes I, L, O and U precisely so no two characters can be confused.
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{21}$/);
    expect(token).not.toMatch(/[+._-]/);
  });

  it("still verifies when an MTA case-folds the whole local part", () => {
    const address = mint();

    const folded = localPartOf(address).toLowerCase() + "@gmail.com";

    expect(verifyReplyToken(folded, [ATTEMPT], SECRET)?.attemptId).toBe(ATTEMPT);
  });

  it("still verifies when a human transcribes 0 as O, or 1 as I or L", () => {
    // Crockford's decoder folds these pairs, and 21 characters make it near-certain that at
    // least one numbered character exists; the search keeps the test deterministic rather than
    // depending on which characters this particular secret happens to produce.
    function tokenContaining(character: string): { token: string; attemptId: string } {
      for (let index = 0; index < 500; index += 1) {
        const attemptId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
        const token = tokenOf(mint(attemptId));

        if (token.includes(character)) {
          return { token, attemptId };
        }
      }

      throw new Error("no minted token contained " + character);
    }

    const zero = tokenContaining("0");
    expect(verifyReplyToken(`jane.doe+${zero.token.replace(/0/g, "O")}@gmail.com`, [zero.attemptId], SECRET)?.attemptId).toBe(zero.attemptId);

    const one = tokenContaining("1");
    expect(verifyReplyToken(`jane.doe+${one.token.replace(/1/g, "I")}@gmail.com`, [one.attemptId], SECRET)?.attemptId).toBe(one.attemptId);
    expect(verifyReplyToken(`jane.doe+${one.token.replace(/1/g, "L")}@gmail.com`, [one.attemptId], SECRET)?.attemptId).toBe(one.attemptId);
  });
});

describe("rejection", () => {
  it("rejects a token with ONE character changed, so the MAC is actually checked", () => {
    const address = mint();
    const token = tokenOf(address);
    // Swap one character for a different member of the alphabet: right length, right alphabet,
    // wrong MAC. Anything less would only prove the length check runs.
    const replacement = token[0] === "0" ? "1" : "0";
    const tampered = replacement + token.slice(1);

    expect(verifyReplyToken(`jane.doe+${tampered}@gmail.com`, [ATTEMPT], SECRET)).toBeNull();
  });

  it("rejects the same token under a different secret", () => {
    const address = mint();

    expect(verifyReplyToken(address, [ATTEMPT], OTHER_SECRET)).toBeNull();
  });

  it("rejects a correctly-sized token whose version byte is not this one", () => {
    expect(verifyReplyToken(`jane.doe+${"Z".repeat(REPLY_TOKEN_LENGTH)}@gmail.com`, [ATTEMPT], SECRET)).toBeNull();
  });

  it("rejects a wrong-length suffix rather than attempting a decode", () => {
    expect(verifyReplyToken("jane.doe+ABC@gmail.com", [ATTEMPT], SECRET)).toBeNull();
  });

  it("returns null for a missing, empty or token-free recipient", () => {
    expect(verifyReplyToken(null, [ATTEMPT], SECRET)).toBeNull();
    expect(verifyReplyToken(undefined, [ATTEMPT], SECRET)).toBeNull();
    expect(verifyReplyToken("", [ATTEMPT], SECRET)).toBeNull();
    expect(verifyReplyToken("jane.doe@gmail.com", [ATTEMPT], SECRET)).toBeNull();
    expect(verifyReplyToken("not an address at all", [ATTEMPT], SECRET)).toBeNull();
  });

  it("returns null when the candidate has no attempts to resolve against", () => {
    expect(verifyReplyToken(mint(), [], SECRET)).toBeNull();
  });
});

describe("the 64-octet local-part ceiling", () => {
  it("keeps every minted local part at or under 64 characters", () => {
    for (const length of [1, 8, 20, 30, 42]) {
      const address = mint(ATTEMPT, `${"a".repeat(length)}@example.com`);
      expect(localPartOf(address).length).toBeLessThanOrEqual(REPLY_TOKEN_MAX_LOCAL_PART);
    }
  });

  it("uses the whole budget at 42 characters and refuses at 43", () => {
    const fits = mint(ATTEMPT, `${"a".repeat(42)}@example.com`);
    expect(localPartOf(fits).length).toBe(REPLY_TOKEN_MAX_LOCAL_PART);

    // 43 + 1 + 21 = 65, one octet over RFC 5321's limit. A null here is the correct answer:
    // a token the transport may reject is a bounced reply, which is worse than no token.
    expect(mintReplyAddress(ATTEMPT, { secret: SECRET, baseAddress: `${"a".repeat(43)}@example.com` })).toBeNull();
  });

  it("covers a maximum-length Gmail local part, which the UUID-carrying layout could not", () => {
    // 30 is Gmail's own ceiling for a new address. Under the 53-character payload+MAC layout the
    // budget was 10 characters; this asserts the corrected layout clears the real-world maximum.
    const address = mint(ATTEMPT, `${"j".repeat(30)}@gmail.com`);

    expect(localPartOf(address).length).toBe(30 + 1 + REPLY_TOKEN_LENGTH);
    expect(verifyReplyToken(address, [ATTEMPT], SECRET)?.attemptId).toBe(ATTEMPT);
  });
});

describe("header parsing", () => {
  it("finds the token inside a display-name header with several recipients", () => {
    const address = mint();
    const header = `"Jane Doe" <${address}>, someone.else@example.com`;

    expect(verifyReplyToken(header, [ATTEMPT], SECRET)?.attemptId).toBe(ATTEMPT);
  });

  it("finds the token when it is not the first address in the header", () => {
    const address = mint();
    const header = `someone.else@example.com, ${address}`;

    expect(verifyReplyToken(header, [ATTEMPT], SECRET)?.attemptId).toBe(ATTEMPT);
  });

  it("ignores an invalid token and keeps scanning the header", () => {
    const address = mint();
    const header = `jane.doe+NOTATOKENATALL9999999@gmail.com, ${address}`;

    expect(verifyReplyToken(header, [ATTEMPT], SECRET)?.attemptId).toBe(ATTEMPT);
  });
});

describe("the signing secret", () => {
  it("is the only thing that can mint a verifiable token", () => {
    const fromOtherSecret = mintReplyAddress(ATTEMPT, { secret: OTHER_SECRET, baseAddress: BASE });

    expect(fromOtherSecret).not.toBeNull();
    expect(verifyReplyToken(fromOtherSecret!, [ATTEMPT], SECRET)).toBeNull();
    expect(verifyReplyToken(fromOtherSecret!, [ATTEMPT], OTHER_SECRET)?.attemptId).toBe(ATTEMPT);
  });

  it("produces a token that does not leak the attempt id it signs", () => {
    // The id is an HMAC input, never an encoded field: nothing in the 21 characters is the UUID.
    const token = tokenOf(mint());
    const hexish = ATTEMPT.replace(/-/g, "").toUpperCase();

    expect(hexish).not.toContain(token);
    expect(token).not.toContain(hexish.slice(0, 8));
  });
});
