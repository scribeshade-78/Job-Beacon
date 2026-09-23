import { ADZUNA_SOURCE_CODE, discoverAdzuna } from "../../ingestion/adapters/adzuna.js";
import type { FetchImpl } from "../../ingestion/types.js";
import type { IntakeAdapter, IntakeFetchResult, IntakeQuery } from "./types.js";

/**
 * Part 3 of the multi-source intake work — Adzuna as an ON-DEMAND intake source.
 *
 * Same wrapper shape and the same reasoning as joobleIntake.ts: DiscoveredVacancy
 * and the write path are shared with the scheduled discovery contract, so this
 * layer only translates the candidate's search context into Adzuna's parameters
 * and the result into the counts the fan-out reads.
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM JOOBLE: Adzuna takes its country as a URL
 * PATH SEGMENT ("/jobs/{country}/search/1"), not as a query parameter, so
 * `query.country` is not merely a normalization nicety here — without it there
 * is no request to make at all.
 */

export const ADZUNA_INTAKE_SOURCE_CODE = ADZUNA_SOURCE_CODE;

export const adzunaIntakeAdapter: IntakeAdapter = {
  sourceCode: ADZUNA_INTAKE_SOURCE_CODE,
  displayName: "Adzuna (aggregator search API)",
  attribution: "Job data from Adzuna (https://www.adzuna.com), a job aggregator.",

  async fetchLiveJobs(query: IntakeQuery, fetchImpl: FetchImpl = fetch): Promise<IntakeFetchResult> {
    const country = (query.country ?? "").trim();

    // Thrown, not returned as an empty result, and thrown HERE rather than left
    // to discoverAdzuna: the fan-out turns a throw into a reported skip carrying
    // this message, and the candidate is the one who can fix it. A silent empty
    // result would read as "Adzuna has no matching jobs", which is a different
    // and false statement.
    //
    // The message names the remedy because the cause is a missing preference,
    // not a broken integration — and because queryContext.ts only ever sets this
    // when the preference was literally a two-letter code, so the honest advice
    // is "state an ISO country", never "check your country name's spelling".
    if (!country) {
      throw new Error(
        "Adzuna intake requires a two-letter country code — add an ISO country (for example US or " +
          "GB) to your preferences. Adzuna's country is a required part of the request URL.",
      );
    }

    // Decision 4: Adzuna's `what` is the same combined role-keyword string the
    // Jooble query uses, so both sources are asked the same question.
    //
    // Left undefined rather than sent as an empty string when the candidate has
    // no selected roles: Adzuna treats an absent `what` as "everything in this
    // country", whereas an empty one is a value the API would have to interpret.
    // Jooble cannot run at all without keywords, so this is the one place the two
    // sources legitimately diverge.
    const what = (query.keywords ?? "").trim();

    // Credentials are read from process.env at call time, mirroring
    // adzunaAdapter.discover in the ingestion layer exactly. Adzuna has no
    // exported credential reader to reuse (unlike Jooble's
    // readJoobleCredentials), and inventing one would be a second definition of
    // how this credential is read. discoverAdzuna itself rejects a blank pair.
    const vacancies = await discoverAdzuna(
      country,
      { what: what || undefined, resultsPerPage: query.limit },
      { appId: process.env.ADZUNA_APP_ID ?? "", appKey: process.env.ADZUNA_APP_KEY ?? "" },
      fetchImpl,
    );

    return {
      vacancies: vacancies.slice(0, query.limit),
      // Same KNOWN LIMITATION as joobleIntake.ts, for the same reason and stated
      // the same way: discoverAdzuna returns a plain DiscoveredVacancy[] with no
      // raw/skipped counts, so these are usable-listing counts rather than the
      // pre-filter counts IntakeFetchResult documents, and `skipped` is 0 because
      // the true figure is not available at this boundary and 0 is the only value
      // that is not a guess.
      received: vacancies.length,
      skipped: 0,
    };
  },
};
