import {
  BILLING_REGIONS,
  type BillingRegion,
} from "../../../shared/pricing";

/**
 * Which region's prices a candidate is shown, and the labels the switcher uses.
 *
 * DETECTION IS A HINT, NEVER A DECISION. It only chooses the initial pill; the
 * candidate can switch, and switching changes what is DISPLAYED and what a new
 * checkout would be priced at — it never rewrites an existing subscription row.
 * A subscription's region is whatever it was bought as, and silently re-pricing
 * somebody because their laptop moved timezone would be a billing bug.
 *
 * The mapping is deliberately small and explicit rather than clever. Timezones
 * are not countries, and a lookup that guessed more than it knows would put
 * someone in the wrong currency at the exact moment they are deciding to pay.
 */

/** The 27 EU member states, for the locale fallback. */
const EU_LOCALE_REGIONS = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/**
 * Timezone first, locale second, US last.
 *
 * THE FALLBACK IS US, NOT IN. An unplaceable visitor used to land on India, which
 * is the cheapest region — so the visitors whose locale we could not read were
 * exactly the ones handed the largest discount, while the ones we had actually
 * placed paid full price. US is the safer answer for somebody we know nothing
 * about, and BillingPanel's escape hatch lets anyone correct it.
 *
 * Every region is still a HINT and never a decision. It chooses what is
 * displayed and what a NEW checkout is priced at; it never re-prices an existing
 * subscription, and the server has the final say on what a subscription costs.
 */
export function detectRegion(timeZone?: string | null, language?: string | null): BillingRegion {
  const tz = (timeZone ?? "").trim();

  if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") {
    return "IN";
  }

  if (tz.startsWith("America/")) {
    return "US";
  }

  // CHECKED BEFORE THE GENERIC Europe/ PREFIX, or London would be swallowed by
  // the EU branch and a UK candidate would see euro prices.
  if (tz === "Europe/London") {
    return "UK";
  }

  if (tz.startsWith("Europe/")) {
    return "EU";
  }

  // The region subtag of a BCP-47 tag: the last segment of "en-GB", "de-DE".
  // Normalised from the legacy underscore form ("en_GB") first.
  const segments = (language ?? "").trim().replace(/_/g, "-").split("-");
  const subtag = segments.length > 1 ? segments[segments.length - 1].toUpperCase() : "";

  if (subtag === "IN") {
    return "IN";
  }

  if (subtag === "US") {
    return "US";
  }

  if (subtag === "GB" || subtag === "UK") {
    return "UK";
  }

  if (EU_LOCALE_REGIONS.has(subtag)) {
    return "EU";
  }

  return "US";
}

/** Reads the browser's own signals. Guarded, because jsdom and any prerender lack them. */
export function detectRegionFromBrowser(): BillingRegion {
  let timeZone: string | null = null;

  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timeZone = null;
  }

  const language = typeof navigator === "undefined" ? null : navigator.language;

  return detectRegion(timeZone, language);
}

/**
 * The switcher's pill text. Distinct from shared/pricing.ts's
 * REGION_OPTION_LABEL ("India (₹)") because the pill also names the currency
 * code, which is the part a candidate comparing regions actually reads.
 * Presentation copy, so it lives here rather than in the canonical catalogue.
 */
export const REGION_SWITCHER_LABEL: Record<BillingRegion, string> = {
  IN: "India (₹ INR)",
  US: "US ($ USD)",
  UK: "UK (£ GBP)",
  EU: "EU (€ EUR)",
};

export { BILLING_REGIONS };
