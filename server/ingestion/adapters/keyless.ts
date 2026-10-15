import type { DiscoveredVacancy, FetchImpl } from "../types.js";
import { arbeitnowIntakeAdapter } from "../../intake/adapters/arbeitnow.js";
import { remotiveIntakeAdapter } from "../../intake/adapters/remotive.js";
import { theMuseIntakeAdapter } from "../../intake/adapters/themuse.js";
import type { IntakeAdapter } from "../../intake/adapters/types.js";
import type { DiscoveryAdapter, DiscoveryAdapterConfig } from "./types.js";

/**
 * The keyless public aggregators (Remotive, Arbeitnow, The Muse) as SCHEDULED
 * DiscoveryAdapters — Step 6's missing half.
 *
 * WHY A WRAPPER RATHER THAN A SECOND NORMALIZER. Each of these already has a verified
 * fetch-and-map implementation on the intake side, including the parts that were read
 * off a real 200 (Arbeitnow's epoch-seconds created_at, The Muse's ISO publication_date,
 * Remotive's deliberately unmapped salary string). Re-normalizing the same payload in a
 * second place is the drift this repository keeps refusing: two definitions of "a
 * Remotive posting" that are free to disagree. So discover() calls the SAME fetch the
 * on-demand path calls and returns the vacancies it produced.
 *
 * THE DIRECTION COUPLING IS REAL AND BOUNDED. server/ingestion/adapters now imports
 * three modules from server/intake/adapters, which is the opposite of the usual
 * direction (intake already imports ingestion/types). It is confined to this one file
 * plus the three registry entries, and it is the price of one normalizer. If the intake
 * feature is ever removed, this file and those entries are exactly what must grow real
 * DiscoveryAdapters.
 *
 * NO PER-TARGET IDENTITY. These are global APIs, not employer boards: targetKey is a
 * stable operator label and is deliberately unused. Nothing here invents a board token.
 *
 * completesSweep IS FALSE, AND THAT IS THE SAFETY-CRITICAL LINE. The worker calls
 * markUnseenVacanciesExpired after a job, which expires every still-active vacancy for
 * the target that the run did not see. One page is not the whole corpus — The Muse
 * serves twenty per page — so reporting completeness here would delete most of these
 * sources' live listings on the first scheduled run.
 */

/**
 * Requested page size for a scheduled sweep.
 *
 * Larger than a candidate's press (the intake path clamps to 100): this is a corpus
 * refresh, so it wants the whole first page rather than a ranking-sized slice, and it is
 * still exactly ONE request per source. Remotive caps itself server-side; Arbeitnow's
 * page is one size regardless; The Muse is fixed at 20.
 */
export const DEFAULT_KEYLESS_DISCOVERY_LIMIT = 500;

export interface KeylessDiscoveryConfig extends DiscoveryAdapterConfig {
  /** Overrides DEFAULT_KEYLESS_DISCOVERY_LIMIT for this target. */
  limit?: number;
}

export function createKeylessDiscoveryAdapter(
  intake: IntakeAdapter,
  defaultLimit: number = DEFAULT_KEYLESS_DISCOVERY_LIMIT,
): DiscoveryAdapter<KeylessDiscoveryConfig> {
  const adapter: DiscoveryAdapter<KeylessDiscoveryConfig> = {
    sourceCode: intake.sourceCode,
    completesSweep: false,

    async discover(_targetKey: string, config: KeylessDiscoveryConfig, fetchImpl: FetchImpl = fetch): Promise<DiscoveredVacancy[]> {
      adapter.validateConfig(config);

      // No search, keywords, location or country: an unattended sweep is not a
      // candidate's question. Sending none of them is also what makes these sources
      // behave predictably — Arbeitnow has no server-side search at all, and its local
      // role filter is inert without keywords.
      const { vacancies } = await intake.fetchLiveJobs({ limit: config.limit ?? defaultLimit }, fetchImpl);

      return vacancies;
    },

    validateConfig(config: KeylessDiscoveryConfig): void {
      if (config.limit !== undefined && (!Number.isInteger(config.limit) || config.limit < 1)) {
        throw new Error(
          `Keyless target config "limit" must be a positive integer; received ${String(config.limit)}.`,
        );
      }
    },
  };

  return adapter;
}

export const remotiveAdapter = createKeylessDiscoveryAdapter(remotiveIntakeAdapter);
export const arbeitnowAdapter = createKeylessDiscoveryAdapter(arbeitnowIntakeAdapter);
export const theMuseAdapter = createKeylessDiscoveryAdapter(theMuseIntakeAdapter);
