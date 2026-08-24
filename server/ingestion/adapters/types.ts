import type { DiscoveredVacancy, FetchImpl } from "../types.js";

/**
 * Configuration specific to a discovery adapter.
 * Each adapter defines its own config shape.
 */
export interface DiscoveryAdapterConfig {
  /** Human-readable name of the company/employer for this target. */
  companyName: string;
  /** Optional company domain for verification/enrichment. */
  companyDomain?: string;
  /** Adapter-specific extra config (e.g., Adzuna country code, USAJOBS category). */
  [key: string]: unknown;
}

/**
 * Formal interface for a discovery adapter.
 * All adapters must implement this to be registered.
 */
export interface DiscoveryAdapter<TConfig extends DiscoveryAdapterConfig = DiscoveryAdapterConfig> {
  /** Unique source code (e.g., "greenhouse", "lever", "adzuna", "usajobs"). */
  readonly sourceCode: string;

  /**
   * Discover vacancies for a single target.
   * @param targetKey - Provider-specific target identifier (e.g., Greenhouse board_token, Lever site slug).
   * @param config - Target-specific configuration (companyName, companyDomain, adapter-specific params).
   * @param fetchImpl - Fetch implementation (allows test injection).
   * @returns Array of normalized DiscoveredVacancy objects.
   */
  discover(
    targetKey: string,
    config: TConfig,
    fetchImpl?: FetchImpl,
  ): Promise<DiscoveredVacancy[]>;

  /**
   * Validate that the target config contains required fields.
   * Called before discovery to fail fast on misconfiguration.
   * @param config - Target configuration to validate.
   * @throws Error if required fields are missing or invalid.
   */
  validateConfig(config: TConfig): void;
}

/**
 * Registry of discovery adapters.
 * Maps source_code to its DiscoveryAdapter implementation.
 */
export type DiscoveryAdapterRegistry = ReadonlyMap<string, DiscoveryAdapter>;