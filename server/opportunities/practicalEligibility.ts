/**
 * Response Intelligence Phase 2.1 — Practical Eligibility rules engine
 * (Opportunity Intelligence PRD §11.3). Pure, deterministic, no I/O — the
 * same shape as server/trust/hardBlocks.ts / positiveReasonCodes.ts.
 *
 * v1 is LOCATION-ONLY. §11.3 also names work authorisation, payroll
 * country, and security clearance as hard blockers and night-shift
 * schedule / experience-certification as soft penalties, but those need an
 * extended extracted_facts vocabulary and/or JD-clause detection that does
 * not exist yet — their reason codes are defined and RESERVED in
 * reasonCodes.ts, never emitted here in v1.
 */
import {
  HARD_BLOCKER_CODES,
  INFO_CODES,
  type ReasonEntry,
} from "./reasonCodes.js";

export interface PracticalEligibilityInput {
  /**
   * The candidate's confirmed `location` fact, effective value
   * (corrected_value ?? fact_value). Free text, e.g. "Bengaluru, India" or
   * "Remote". null when the candidate has no confirmed location fact.
   */
  candidateLocation: string | null;
  vacancy: {
    country: string | null;
    region: string | null;
    city: string | null;
    remoteType: "remote" | "hybrid" | "on_site" | null;
  };
}

export interface PracticalEligibility {
  /** 0-100, or null when there is not enough data (INSUFFICIENT_DATA). */
  score: number | null;
  hardBlockers: ReasonEntry[];
  softPenalties: ReasonEntry[];
}

/**
 * Small alias map so a free-text candidate location can be matched to a
 * vacancy's `country` string without a geocoding service. Each entry is a
 * set of interchangeable tokens; if the candidate string and the vacancy
 * country string resolve to the same set (or one contains a token of the
 * other), they are the same country.
 *
 * ponytail: naive token/substring match; add real geocoding only if
 * false-positives show up against real data.
 */
const COUNTRY_ALIASES: string[][] = [
  ["united states", "usa", "us", "u.s.", "u.s.a.", "america"],
  ["united kingdom", "uk", "u.k.", "great britain", "britain", "england", "scotland", "wales"],
  ["united arab emirates", "uae", "u.a.e."],
  ["india", "in", "bharat"],
  ["germany", "de", "deutschland"],
  ["canada", "ca"],
  ["australia", "au"],
  ["singapore", "sg"],
];

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** All tokens that mean the same country as `token`, including itself. */
function aliasGroup(token: string): string[] {
  const found = COUNTRY_ALIASES.find((group) => group.includes(token));
  return found ?? [token];
}

/**
 * Short tokens ("us", "in", "de", "ca") match only on a word boundary —
 * plain substring would fire on "Austin"/"Belarus"/"Indiana". Longer
 * tokens ("india", "united states") stay substring so "Bengaluru, India"
 * matches "india".
 */
function containsToken(haystack: string, token: string): boolean {
  if (token.length <= 3) {
    return new RegExp(`(^|[^a-z])${token.replace(/[.\\]/g, "\\$&")}([^a-z]|$)`).test(haystack);
  }
  return haystack.includes(token);
}

/**
 * True when the free-text candidate location refers to the same country as
 * the vacancy's `country` string. Checks the alias group of the vacancy
 * country against the candidate string, then the reverse.
 */
function sameCountry(candidateLocation: string, vacancyCountry: string): boolean {
  const cand = normalise(candidateLocation);
  const vac = normalise(vacancyCountry);

  if (cand === vac) {
    return true;
  }

  for (const token of aliasGroup(vac)) {
    if (containsToken(cand, token)) {
      return true;
    }
  }
  for (const token of aliasGroup(cand)) {
    if (containsToken(vac, token)) {
      return true;
    }
  }
  return false;
}

export function evaluatePracticalEligibility(
  input: PracticalEligibilityInput,
): PracticalEligibility {
  const { candidateLocation, vacancy } = input;

  // A remote role is never location-blocked, regardless of candidate data.
  if (vacancy.remoteType === "remote") {
    return { score: 100, hardBlockers: [], softPenalties: [] };
  }

  // Non-remote (hybrid / on_site / unknown remote type) — need both the
  // candidate location and the vacancy country to evaluate.
  if (candidateLocation === null || candidateLocation.trim() === "") {
    return {
      score: null,
      hardBlockers: [],
      softPenalties: [],
    };
  }

  if (vacancy.country === null || vacancy.country.trim() === "") {
    // Don't penalise missing source data — the same "ingestion resilience"
    // ethos trust scoring uses. Eligible, with an informational note.
    return {
      score: 100,
      hardBlockers: [],
      softPenalties: [],
    };
  }

  if (sameCountry(candidateLocation, vacancy.country)) {
    return { score: 100, hardBlockers: [], softPenalties: [] };
  }

  return {
    score: 0,
    hardBlockers: [
      {
        code: "LOCATION_PRESENCE",
        detail: `${HARD_BLOCKER_CODES.LOCATION_PRESENCE} Candidate: "${candidateLocation}"; role country: "${vacancy.country}".`,
      },
    ],
    softPenalties: [],
  };
}

/**
 * The informational code a caller should attach when score is null or the
 * vacancy country was missing — kept here so the mapping lives next to the
 * rules rather than in the worker. Returns null when there is nothing to
 * note.
 */
export function eligibilityInfoCode(
  input: PracticalEligibilityInput,
  result: PracticalEligibility,
): ReasonEntry | null {
  if (result.score === null) {
    return { code: "INSUFFICIENT_DATA", detail: INFO_CODES.INSUFFICIENT_DATA };
  }
  if (
    input.vacancy.remoteType !== "remote" &&
    (input.vacancy.country === null || input.vacancy.country.trim() === "")
  ) {
    return { code: "LOCATION_UNKNOWN", detail: INFO_CODES.LOCATION_UNKNOWN };
  }
  return null;
}
