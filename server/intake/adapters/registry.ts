import type { IntakeAdapter } from "./types.js";
import { remotiveIntakeAdapter } from "./remotive.js";
import { joobleIntakeAdapter } from "./joobleIntake.js";
import { adzunaIntakeAdapter } from "./adzunaIntake.js";

/**
 * Registry of on-demand intake adapters.
 *
 * Separate from server/ingestion/adapters/registry.ts on purpose — see
 * ./types.ts for why the two contracts are adjacent rather than unified. Adding
 * an adapter here does NOT make it pollable by the scheduled ingestion worker;
 * that still requires a DiscoveryAdapter plus a vacancy_sources row.
 */
/**
 * Order is the fan-out's execution order, and it is deliberate: Remotive first,
 * because it needs neither a credential nor any candidate context and therefore
 * still returns listings when the two credentialed aggregators are skipped for a
 * missing preference. A run that ends with nothing is then at least known to
 * have tried the one source that cannot fail for configuration reasons.
 */
const ADAPTERS: readonly IntakeAdapter[] = [
  remotiveIntakeAdapter,
  joobleIntakeAdapter,
  adzunaIntakeAdapter,
];

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
