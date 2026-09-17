import {
  discoverJooble,
  readJoobleCredentials,
  redactJoobleEndpoint,
} from "./adapters/jooble.js";

/**
 * Jooble adapter smoke check — the ONE acceptance test that needs a real key.
 *
 * WHY THIS EXISTS: every other test in this repository runs against fixtures,
 * and usajobs.ts already documents the trap this script is meant to avoid —
 * a field mapping that is internally consistent and passes its fixture test
 * while still being wrong about the live provider. This script spends exactly
 * ONE request from the key's lifetime quota (500 total on the free plan) and
 * reports what the live response actually contained, including a diff between
 * the documented field list and the fields the provider really returned.
 *
 * It deliberately does NOT touch the database, so it can be run before the
 * source_policies row or any vacancy_sources target exists.
 *
 * USAGE (the flag is required so a stray invocation cannot silently spend quota):
 *   npm run jooble:smoke -- --confirm-spend
 *
 * Override the saved search without editing this file:
 *   JOOBLE_SMOKE_KEYWORDS="Data Engineer" JOOBLE_SMOKE_LOCATION="Berlin" \
 *   JOOBLE_SMOKE_COUNTRY=DE npm run jooble:smoke -- --confirm-spend
 *
 * The script never prints the API key or the credential-bearing request URL —
 * see the redaction self-check at the end, which proves that claim rather than
 * asserting it.
 */

/** Fields Jooble's REST API documentation lists on each job object. */
const DOCUMENTED_JOB_FIELDS: readonly string[] = [
  "id",
  "title",
  "location",
  "snippet",
  "salary",
  "source",
  "type",
  "link",
  "company",
  "updated",
];

function main(): void {
  const args = process.argv.slice(2);

  if (!args.includes("--confirm-spend")) {
    console.log(
      [
        "Refusing to run without --confirm-spend.",
        "",
        "This check sends one real request to Jooble. The free plan is a LIFETIME",
        "quota of 500 requests per key, so it is not run accidentally.",
        "",
        "  npm run jooble:smoke -- --confirm-spend",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const keywords = process.env.JOOBLE_SMOKE_KEYWORDS ?? "Sales Manager";
  const location = process.env.JOOBLE_SMOKE_LOCATION ?? "United States";
  // JoobleTargetConfig.country is optional (string | undefined), not nullable —
  // an unset value means "omit it", which is what leaves vacancies.country null.
  const country = process.env.JOOBLE_SMOKE_COUNTRY || undefined;

  run(keywords, location, country).catch((error: unknown) => {
    // Error messages from the adapter are already credential-redacted; this
    // second pass is belt-and-braces for anything thrown by a dependency.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[jooble-smoke] FAILED: " + redactJoobleEndpoint(message));
    process.exitCode = 1;
  });
}

async function run(
  keywords: string,
  location: string,
  country: string | undefined,
): Promise<void> {
  // Throws a clear, value-free error if JOOBLE_API_KEY is unset or a placeholder.
  const credentials = readJoobleCredentials();

  console.log("[jooble-smoke] endpoint: " + redactJoobleEndpoint("https://jooble.org/api/placeholder"));
  console.log('[jooble-smoke] search: keywords="' + keywords + '" location="' + location + '"');
  console.log("[jooble-smoke] budget: 1 request, 0 retries (maxPages=1, maxRetries=0)");
  console.log("");

  const startedAt = Date.now();

  const results = await discoverJooble(
    {
      keywords,
      location,
      country,
      // 50 rather than the adapter's 100 default: this check validates the
      // response shape, not volume, and a smaller page keeps the printed
      // output readable.
      resultsPerPage: 50,
      maxPages: 1,
      maxRetries: 0,
      minIntervalMs: 0,
    },
    credentials,
  );

  const elapsedMs = Date.now() - startedAt;

  console.log("[jooble-smoke] normalized " + results.length + " vacancies in " + elapsedMs + "ms");
  console.log("");

  if (results.length === 0) {
    console.log(
      "[jooble-smoke] ZERO results. That is a valid API response, but a surprising one for a",
    );
    console.log(
      "[jooble-smoke] broad keyword/location pair — check that the key's country domain matches",
    );
    console.log("[jooble-smoke] the location you searched before treating this as success.");
  }

  // --- Contract check: documented fields vs fields the provider really sent ---
  const firstRaw = (results[0]?.raw ?? null) as Record<string, unknown> | null;

  if (firstRaw === null) {
    console.log("[jooble-smoke] no payload to compare against the documented field list.");
  } else {
    const actualFields = Object.keys(firstRaw);
    const missing = DOCUMENTED_JOB_FIELDS.filter((field) => !actualFields.includes(field));
    const undocumented = actualFields.filter((field) => !DOCUMENTED_JOB_FIELDS.includes(field));

    console.log("[jooble-smoke] contract check against the documented job fields:");
    console.log("[jooble-smoke]   fields present: " + actualFields.length);
    console.log(
      "[jooble-smoke]   documented but absent: " + (missing.length ? missing.join(", ") : "(none)"),
    );
    console.log(
      "[jooble-smoke]   present but undocumented: " +
        (undocumented.length ? undocumented.join(", ") : "(none)"),
    );
  }

  // --- Normalization spot-check: what each mapped field actually became ---
  console.log("");
  console.log("[jooble-smoke] normalized output (first " + Math.min(3, results.length) + "):");

  for (const vacancy of results.slice(0, 3)) {
    // Printed field-by-field rather than as JSON, so a surprising value is
    // obvious and no provider payload floods the terminal.
    let host = "(unparseable)";
    try {
      host = new URL(vacancy.authoritativeUrl).host;
    } catch {
      host = "(unparseable)";
    }

    console.log(
      [
        "  - id=" + vacancy.sourceVacancyId,
        "title=" + JSON.stringify(vacancy.rawTitle),
        "company=" + JSON.stringify(vacancy.companyName),
        "country=" + String(vacancy.country),
        "salary=" +
          String(vacancy.salaryMin) +
          "-" +
          String(vacancy.salaryMax) +
          " " +
          String(vacancy.currency),
        "interval=" + String(vacancy.salaryInterval),
        "publishedAt=" + String(vacancy.publishedAt),
        "linkHost=" + host,
      ].join(" "),
    );
  }

  const withSalary = results.filter((v) => v.salaryMin !== null).length;
  const withCountry = results.filter((v) => v.country !== null).length;

  console.log("");
  console.log(
    "[jooble-smoke] " + withSalary + "/" + results.length + " carried a parseable salary; " +
      withCountry + "/" + results.length + " carry a country (from target config, never the payload).",
  );

  // --- Redaction self-check ---
  console.log("");
  const sampleKey = credentials.apiKey;
  const redacted = redactJoobleEndpoint("https://jooble.org/api/" + sampleKey);
  const leakFree = !redacted.includes(sampleKey) && !redacted.includes(credentials.apiKey);

  console.log("[jooble-smoke] redaction self-check: " + (leakFree ? "PASS" : "FAIL"));
  console.log("[jooble-smoke]   a credential-bearing URL renders as: " + redacted);

  if (!leakFree) {
    console.error("[jooble-smoke] redaction FAILED — do not enable this source until fixed.");
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("[jooble-smoke] done. Remember to top up your mental counter: 1 request spent.");
}

main();
