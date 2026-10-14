import { describe, expect, it } from "vitest";
import { ATS_SOURCE_CODES } from "../../ats/credentials.js";
import { SITE_PROFILES } from "../../../extension/src/lib/sites.js";

/**
 * The extension's site registry and the server's ATS source codes describe the
 * same idea from two sides of the wire, and the strings have to agree. This test
 * lives under server/ rather than beside sites.ts because it is the SERVER
 * project that has Node types: extension/tsconfig.json pins
 * types: ["vite/client"], so importing the server's credential module from an
 * extension test would break `npm run typecheck` on its node:crypto import.
 *
 * The two lists are NOT expected to be equal, and that is the point:
 *   - every source the server can SUBMIT to needs an extension profile, or a
 *     candidate can be sent to a board the extension cannot fill;
 *   - the extension may know sites the server cannot submit to (workday today),
 *     because the extension fills and the candidate submits. That is a
 *     capability difference, not drift.
 */
describe("site registry parity with the server's ATS source codes", () => {
  it("has an extension profile for every source the server can submit to", () => {
    const profileCodes = new Set(SITE_PROFILES.map((p) => p.sourceCode));
    const missing = ATS_SOURCE_CODES.filter((code) => !profileCodes.has(code));
    expect(missing).toEqual([]);
  });

  it("never spells a known source differently (near-miss guard)", () => {
    // The real drift this catches is a profile calling greenhouse "gh" or
    // "green-house": it would typecheck, look plausible, and silently never match
    // the server's row. Normalizing both sides is what makes the near miss
    // visible.
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const known = new Set(ATS_SOURCE_CODES.map(normalize));
    for (const profile of SITE_PROFILES) {
      if ((ATS_SOURCE_CODES as readonly string[]).includes(profile.sourceCode)) continue;
      expect(known.has(normalize(profile.sourceCode))).toBe(false);
    }
  });

  it("reuses the server's exact strings for the sources it does know", () => {
    // Imported constants are asserted against the registry rather than retyped,
    // so renaming a source on the server fails here instead of at fill time.
    expect(SITE_PROFILES.map((p) => p.sourceCode)).toEqual(expect.arrayContaining([...ATS_SOURCE_CODES]));
  });
});
