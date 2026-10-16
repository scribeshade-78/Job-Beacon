import { describe, expect, it } from "vitest";
import { buildCodeChallenge, createCodeVerifier } from "./oauthState.js";

/**
 * RFC 7636 S256, ASSERTED AGAINST THE SPECIFICATION RATHER THAN A ROUND TRIP.
 *
 * WHY THIS IS A SEPARATE TEST FROM THE FLOW TESTS. A challenge computed the wrong way - wrong
 * alphabet, wrong padding, hashing the challenge instead of the verifier - still round-trips
 * against OUR OWN verifier, because our code would be consistently wrong on both sides. The only
 * thing that can catch that is an external constant, which is what Appendix B gives us.
 *
 * The vector below is RFC 7636 Appendix B's worked example, copied from the specification:
 *
 *   code_verifier  = dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
 *   code_challenge = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
 *
 * If Google ever disagrees with our challenge, it will disagree in exactly this way, and this test
 * is what fails first instead.
 */
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("buildCodeChallenge - RFC 7636 S256", () => {
  it("reproduces the specification's own test vector", () => {
    expect(buildCodeChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("emits BASE64URL with NO padding, which is what section 4.2 requires", () => {
    const challenge = buildCodeChallenge(RFC_VERIFIER);

    // '+' and '/' are standard base64 and '=' is padding; all three are forbidden here.
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it("is deterministic - the same verifier always yields the same challenge", () => {
    expect(buildCodeChallenge(RFC_VERIFIER)).toBe(buildCodeChallenge(RFC_VERIFIER));
  });

  it("differs for a verifier that differs by one character", () => {
    expect(buildCodeChallenge(RFC_VERIFIER + "x")).not.toBe(buildCodeChallenge(RFC_VERIFIER));
  });
});

describe("createCodeVerifier - RFC 7636 section 4.1", () => {
  it("is 43-128 characters of the unreserved alphabet", () => {
    const verifier = createCodeVerifier();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("is unique per call, so two handshakes cannot share a challenge", () => {
    const seen = new Set(Array.from({ length: 50 }, () => createCodeVerifier()));

    expect(seen.size).toBe(50);
  });

  it("produces a challenge that satisfies the same alphabet rules", () => {
    expect(buildCodeChallenge(createCodeVerifier())).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});
