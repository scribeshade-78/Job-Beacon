import {
  discoverJooble,
  JOOBLE_SOURCE_CODE,
  readJoobleCredentials,
} from "../../ingestion/adapters/jooble.js";
import type { FetchImpl } from "../../ingestion/types.js";
import type { IntakeAdapter, IntakeFetchResult, IntakeQuery } from "./types.js";

/**
 * Part 3 of the multi-source intake work — Jooble as an ON-DEMAND intake source.
 *
 * WHY THIS WRAPS discoverJooble RATHER THAN REIMPLEMENTING IT. DiscoveredVacancy,
 * ingestDiscoveredVacancy, the trust scorer and the fingerprint are one
 * implementation shared by both contracts (see adapters/types.ts for why the two
 * interfaces are adjacent rather than unified). Re-fetching Jooble here would
 * mean a second definition of what a Jooble listing is, free to drift from the
 * one the scheduled path normalizes.
 *
 * WHAT THIS LAYER ADDS, and it is only two things: it turns the candidate's
 * search context into Jooble's target config, and it turns a plain
 * DiscoveredVacancy[] into the IntakeFetchResult the fan-out reads.
 *
 * THE QUOTA IS THE CONSTRAINT THAT SHAPES EVERYTHING HERE. Jooble's free plan is
 * a lifetime total of 500 requests per key, not monthly and not daily
 * (docs/JOOBLE_INTEGRATION.md §1.3). One press of "Fetch latest jobs" must
 * therefore cost exactly ONE request — see fetchLiveJobs.
 */

export const JOOBLE_INTAKE_SOURCE_CODE = JOOBLE_SOURCE_CODE;

export const joobleIntakeAdapter: IntakeAdapter = {
  sourceCode: JOOBLE_INTAKE_SOURCE_CODE,
  displayName: "Jooble (aggregator REST API)",
  // Jooble syndicates listings from other sites, so the honest framing names it
  // as an aggregator rather than implying it is the employer's own board.
  attribution: "Job data from Jooble (https://jooble.org), a job aggregator.",

  async fetchLiveJobs(query: IntakeQuery, fetchImpl: FetchImpl = fetch): Promise<IntakeFetchResult> {
    const keywords = (query.keywords ?? "").trim();
    const location = (query.location ?? "").trim();

    // Checked HERE, before the credential is read and before any request is
    // attempted, then thrown rather than returned as an empty result.
    //
    // A throw is the correct signal because the fan-out converts it into a
    // reported skip with this reason attached. Returning zero listings instead
    // would tell the candidate "Jooble has no jobs matching that" when the truth
    // is that Jooble was never asked — and those two are not the same answer.
    // discoverJooble also rejects a missing pair, but by then the credential has
    // been read, and this layer is where the candidate-facing reason belongs.
    if (!keywords) {
      throw new Error(
        "Jooble intake requires keywords — select at least one target role, otherwise there is " +
          "nothing to search for. Jooble documents keywords as a required request parameter.",
      );
    }

    if (!location) {
      throw new Error(
        "Jooble intake requires a location — confirm a location fact, or set a preferred city or " +
          "country. Jooble documents location as a required request parameter.",
      );
    }

    // ONE REQUEST PER CLICK, BY CONSTRUCTION.
    //
    // resultsPerPage is the caller's limit and maxPages is 1, so this cannot
    // silently become a page loop. That pairing is a quota decision rather than
    // tuning: Jooble charges the same single request for a large page as for a
    // small one (ResultOnPage is free), so a bigger page is strictly cheaper
    // than more pages, and a second page would be a second request spent
    // against a lifetime budget of 500.
    //
    // `country` IS DELIBERATELY NOT FORWARDED, even though IntakeQuery now
    // carries one and JoobleTargetConfig accepts it. Jooble's key is
    // country-scoped — jooble.org issues US listings, uk.jooble.org issues UK
    // ones — so a listing's country is a property of the CREDENTIAL, not of the
    // candidate's preference. Filling it from preferred_countries would label a
    // US posting as, say, Indian whenever the candidate happens to prefer India,
    // and vacancies.country is a column other code filters on. Left unset, which
    // the adapter already handles by writing NULL.
    const vacancies = await discoverJooble(
      {
        keywords,
        location,
        resultsPerPage: query.limit,
        maxPages: 1,
      },
      readJoobleCredentials(),
      fetchImpl,
    );

    return {
      vacancies: vacancies.slice(0, query.limit),
      // KNOWN LIMITATION, stated rather than papered over: discoverJooble
      // returns a plain DiscoveredVacancy[] and does NOT report how many raw
      // listings the API returned, nor how many it dropped while normalizing
      // (it filters out entries with no id or no link internally, with no
      // counter exposed). So `received` here is a count of USABLE listings, not
      // the pre-filter count IntakeFetchResult documents, and `skipped` is 0
      // because zero is the only value that would not be invented — the real
      // figure is genuinely unavailable at this boundary. Remotive's adapter can
      // report both honestly because it owns its own mapping; this one delegates
      // to a layer that does not expose them.
      received: vacancies.length,
      skipped: 0,
    };
  },
};
