import { describe, expect, it } from "vitest";
import { ADZUNA_SUPPORTED_MARKETS, routeMarket } from "../intake/marketRouting.js";

/**
 * DRIFT GATE for Adzuna's supported markets.
 *
 * THE CONSTANT IT GUARDS IS COPIED FROM A REAL 404, because Adzuna's documentation
 * could not be read. A copied list is a fact about a moment, so this suite re-checks
 * it against the live API and fails with the exact difference when it moves.
 *
 * WHY THIS IS NOT IN `npm test`. It makes about twenty real HTTP calls. Putting that
 * in the default suite would let a vendor outage fail the build for everyone, and a
 * gate that fails when nothing is wrong is worse than no gate.
 *
 * COST: roughly 20 requests per run, at results_per_page=1 so the payloads are tiny.
 * Run it deliberately - after an Adzuna error, before a release that touches routing,
 * or when someone reports a market unexpectedly returning nothing.
 *
 *   npm run test:integration
 */

// Reads .env when present, so the suite works without exporting by hand. Absent keys
// are then reported by the first test rather than by a confusing 401 later.
try {
  (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(".env");
} catch {
  // No .env is a normal state; the credential test below says so plainly.
}

const APP_ID = process.env.ADZUNA_APP_ID ?? "";
const APP_KEY = process.env.ADZUNA_APP_KEY ?? "";

const credentialsPresent = APP_ID.length > 0 && APP_KEY.length > 0;

/** results_per_page=1: this suite is about STATUS CODES, not about job volume. */
function marketUrl(market: string): string {
  return (
    "https://api.adzuna.com/v1/api/jobs/" +
    encodeURIComponent(market) +
    "/search/1?app_id=" + encodeURIComponent(APP_ID) +
    "&app_key=" + encodeURIComponent(APP_KEY) +
    "&results_per_page=1&content-type=application/json"
  );
}

async function probe(market: string) {
  const response = await fetch(marketUrl(market));
  const text = await response.text();

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A non-JSON body is itself worth seeing in the failure message.
  }

  return { status: response.status, body, text };
}

describe("Adzuna market drift (integration)", () => {
  it("has credentials, so this suite is actually testing something", () => {
    // Fails rather than skips. A drift gate that quietly skips when unconfigured is a
    // false assurance, which is the failure mode this whole suite exists to avoid.
    expect(
      credentialsPresent,
      "ADZUNA_APP_ID and ADZUNA_APP_KEY must be set (or present in .env) to run the integration suite.",
    ).toBe(true);
  });

  it("reads the SAME market list from the live API that the code hardcodes", async () => {
    // THE STRONGEST ASSERTION HERE. The 404 body carries the authoritative list, so
    // this compares our copied constant against the vendor's current answer and fails
    // with the difference rather than making a reviewer spot it.
    if (!credentialsPresent) {
      expect.unreachable("credentials missing - see the test above");
    }

    const { status, body } = await probe("ae");

    expect(status).toBe(404);

    const display = String((body as { display?: unknown } | null)?.display ?? "");
    const advertised = (display.match(/\b[a-z]{2}\b/g) ?? [])
      .map((code) => code.toUpperCase())
      .filter((code, index, all) => all.indexOf(code) === index)
      .sort();

    expect(advertised).toEqual([...ADZUNA_SUPPORTED_MARKETS].sort());
  });

  it.each([...ADZUNA_SUPPORTED_MARKETS])("serves %s with 200", async (market) => {
    if (!credentialsPresent) {
      expect.unreachable("credentials missing - see the first test");
    }

    const { status, body } = await probe(market.toLowerCase());

    expect(status, "market " + market + " no longer answers 200").toBe(200);
    expect(Array.isArray((body as { results?: unknown } | null)?.results)).toBe(true);
  });

  it("REJECTS a market it does not serve, and says why", async () => {
    if (!credentialsPresent) {
      expect.unreachable("credentials missing - see the first test");
    }

    const { status, body } = await probe("ae");

    expect(status).toBe(404);
    expect((body as { exception?: unknown } | null)?.exception).toBe("UNSUPPORTED_COUNTRY");
  });

  it("routes every market Adzuna refuses to SerpApi, never to Adzuna", async () => {
    // The link between the API's truth and our routing decision: a code outside the
    // supported set must route AWAY from Adzuna, or the request 404s in production.
    for (const market of ["AE", "NG", "JP", "ZZ"]) {
      expect(routeMarket(market), market + " must not route to Adzuna").not.toBe("adzuna");
    }
  });

  it("sends Adzuna the LOWER-CASE market its URL path requires", async () => {
    // The defect that shipped once: /jobs/GB/ answers 404 while /jobs/gb/ answers 200.
    // Asserted against the live API rather than against our own constant, so this
    // cannot pass by agreeing with our bug.
    if (!credentialsPresent) {
      expect.unreachable("credentials missing - see the first test");
    }

    const upper = await probe("GB");
    const lower = await probe("gb");

    expect(upper.status).toBe(404);
    expect(lower.status).toBe(200);
  });
});
