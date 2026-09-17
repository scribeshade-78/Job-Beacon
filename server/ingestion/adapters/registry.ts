import type { DiscoveryAdapter, DiscoveryAdapterRegistry } from "./types.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { adzunaAdapter } from "./adzuna.js";
import { usajobsAdapter } from "./usajobs.js";
import { joobleAdapter } from "./jooble.js";

/**
 * Registry of all registered discovery adapters.
 * Maps source_code to its DiscoveryAdapter implementation.
 *
 * To add a new adapter:
 * 1. Create the adapter implementing DiscoveryAdapter interface
 * 2. Import it here
 * 3. Add it to the ADAPTERS array below
 */
const ADAPTERS: readonly DiscoveryAdapter[] = [
  greenhouseAdapter,
  leverAdapter,
  adzunaAdapter,
  usajobsAdapter,
  joobleAdapter,
] as const;

/**
 * Immutable registry map built from the ADAPTERS array.
 * Using a Map for O(1) lookup.
 */
export const discoveryAdapterRegistry: DiscoveryAdapterRegistry = new Map(
  ADAPTERS.map((adapter) => [adapter.sourceCode, adapter]),
);

/**
 * Get the discovery adapter for a given source code.
 * @param sourceCode - The source code (e.g., "greenhouse", "lever")
 * @returns The DiscoveryAdapter implementation
 * @throws Error if no adapter is registered for the source code
 */
export function getDiscoveryAdapter(sourceCode: string): DiscoveryAdapter {
  const adapter = discoveryAdapterRegistry.get(sourceCode);
  if (!adapter) {
    throw new Error(`No discovery adapter registered for source_code "${sourceCode}".`);
  }
  return adapter;
}

/**
 * Check if a discovery adapter is registered for the given source code.
 * @param sourceCode - The source code to check
 * @returns true if an adapter is registered
 */
export function hasDiscoveryAdapter(sourceCode: string): boolean {
  return discoveryAdapterRegistry.has(sourceCode);
}

/**
 * Get all registered source codes.
 * @returns Array of source codes
 */
export function getRegisteredSourceCodes(): readonly string[] {
  return ADAPTERS.map((adapter) => adapter.sourceCode);
}