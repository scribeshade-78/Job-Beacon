import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURE_MATRIX, PLAN_CATALOGUE } from "./pricing.js";

/**
 * No candidate-facing surface may advertise automatic application.
 *
 * WHY THIS IS A TEST AND NOT A REVIEW NOTE. The claims removed here were not
 * typos: every one of them was written deliberately, described a feature that
 * had a plausible-looking implementation behind it, and stayed wrong for as long
 * as nobody looked. A future reader who adds an adapter and wants to advertise it
 * should have to delete this test and justify it, rather than reinstate the copy
 * because the string is convenient.
 *
 * WHAT WOULD MAKE THESE CLAIMS TRUE: a job source whose policy permits automated
 * application AND a registered adapter for that source. No source holding
 * vacancies satisfies both today (see server/applications/queueCapability.ts).
 *
 * Same source-scanning precedent as this directory's pricing.parity.test.ts, and
 * the same reason for resolve(process.cwd(), ...) rather than import.meta.url:
 * these run under jsdom, where import.meta.url is an http: URL.
 */
const CANDIDATE_FACING_SURFACES = [
  "client/src/panels/BillingPanel.tsx",
];

/**
 * Strips comments before scanning.
 *
 * The accurate explanation of WHY a claim was removed necessarily quotes the
 * claim ("Showing '30 auto-applies / month' sold a capability that did not
 * exist"). Scanning raw text would fail on the comment that documents the fix,
 * which would push future authors to delete the explanation instead of keeping
 * it — the opposite of what this test is for. So the assertions below run
 * against executable code, and the commentary is left free.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readCode(relativePath: string): string {
  return stripComments(readFileSync(resolve(process.cwd(), relativePath), "utf8"));
}

describe("candidate-facing pricing makes no automatic-application claims", () => {
  it("never shows a monthly auto-apply figure", () => {
    for (const surface of CANDIDATE_FACING_SURFACES) {
      const source = readCode(surface);

      // The quota helper and its copy were removed; the phrasing must not return.
      expect(source).not.toContain("auto-applies / month");
      expect(source).not.toContain("regionalAutoApplyQuota");
      expect(source).not.toContain("autoApplyPerMonth");
      // The per-account usage lines were a live claim too.
      expect(source).not.toContain("auto_apply_india_per_month");
      expect(source).not.toContain("auto_apply_us_per_month");
    }
  });

  it("never claims a plan includes auto-submit", () => {
    for (const surface of CANDIDATE_FACING_SURFACES) {
      const source = readCode(surface);

      expect(source).not.toContain("Auto-submit");
      expect(source).not.toContain("Auto-apply");
    }
  });

  /**
   * The old copy listed "No automated applying" on Free only, which implies the
   * paid tiers DO have it. They do not, so the contrast itself was the claim.
   */
  it("never frames automation as a per-tier difference", () => {
    const source = readCode("client/src/panels/BillingPanel.tsx");

    expect(source).not.toContain("No automated applying");
  });

  it("states once, for every tier, that automatic submission is unavailable", () => {
    const source = readCode("client/src/panels/BillingPanel.tsx");

    expect(source).toContain("Automatic submission unavailable.");
  });

  it("keeps the internal quota figures in the catalogue for the seed and parity test", () => {
    // Deliberately still present: removing them would break the seed migration
    // and pricing.parity.test.ts. They are retained as data, not as marketing.
    for (const plan of PLAN_CATALOGUE) {
      expect(typeof plan.autoApplyPerMonth.india).toBe("number");
      expect(typeof plan.autoApplyPerMonth.us).toBe("number");
    }
  });

  it("has no auto-submit row in the feature matrix", () => {
    const features = FEATURE_MATRIX.map((row) => row.feature);

    expect(features.some((feature) => /auto-?(submit|apply)/i.test(feature))).toBe(false);
  });

  it("describes no plan as providing application, only discovery", () => {
    for (const plan of PLAN_CATALOGUE) {
      expect(plan.description.toLowerCase()).not.toContain("autonomous discovery and application");
    }
  });
});
