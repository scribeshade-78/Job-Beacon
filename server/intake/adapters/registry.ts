import type { IntakeAdapter } from "./types.js";
import { remotiveIntakeAdapter } from "./remotive.js";

/**
 * Registry of on-demand intake adapters.
 *
 * Separate from server/ingestion/adapters/registry.ts on purpose — see
 * ./types.ts for why the two contracts are adjacent rather than unified. Adding
 * an adapter here does NOT make it pollable by the scheduled ingestion worker;
 * that still requires a DiscoveryAdapter plus a vacancy_sources row.
 */
const ADAPTERS: readonly IntakeAdapter[] = [remotiveIntakeAdapter];

export const intakeAdapterRegistry: ReadonlyMap<string, IntakeAdapter> = new Map(
  ADAPTERS.map((adapter) => [adapter.sourceCode, adapter]),
);

export function getIntakeAdapter(sourceCode: string): IntakeAdapter {
  const adapter = intakeAdapterRegistry.get(sourceCode);

  if (!adapter) {
    const known = ADAPTERS.map((entry) => entry.sourceCode).join(", ");
    throw new Error(`No intake adapter registered for source_code "${sourceCode}". Registered: ${known}.`);
  }

  return adapter;
}

export function listIntakeAdapters(): readonly IntakeAdapter[] {
  return ADAPTERS;
}
