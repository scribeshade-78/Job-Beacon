import type { IntakeAdapter } from "./types.js";
import { remotiveIntakeAdapter } from "./remotive.js";
import { joobleIntakeAdapter } from "./joobleIntake.js";
import { adzunaIntakeAdapter } from "./adzunaIntake.js";
import { theMuseIntakeAdapter } from "./themuse.js";

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

/**
 * The env flag that opts The Muse in. Named as a constant so the adapter, the
 * registry and the tests cannot disagree about its spelling.
 */
export const THE_MUSE_INTAKE_FLAG = "THE_MUSE_INTAKE_ENABLED";

/**
 * Sources that are registered in code but OFF unless an operator turns them on.
 *
 * WHY THE MUSE IS OPT-IN WHEN JOOBLE AND ADZUNA ARE NOT. All three are
 * third-party aggregators, but The Muse is the only one added by this change
 * whose terms and quota have not been looked at by anyone yet, and its place in
 * the fan-out is therefore a deliberate operator decision rather than a default
 * that quietly starts spending requests. Turning it on is one environment
 * variable; shipping it on would be this change making that decision for
 * whoever deploys next.
 */
const OPT_IN: ReadonlyArray<{ flag: string; adapter: IntakeAdapter }> = [
  { flag: THE_MUSE_INTAKE_FLAG, adapter: theMuseIntakeAdapter },
];

/**
 * Fail-closed: only the exact string "true" enables a source. Anything else —
 * unset, empty, "1", "yes", "TRUE" — leaves it off, so a typo in a deployment
 * cannot silently enable a source nobody meant to turn on.
 */
export function isOptInIntakeEnabled(flag: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[flag] === "true";
}

export function isTheMuseIntakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptInIntakeEnabled(THE_MUSE_INTAKE_FLAG, env);
}

/**
 * The always-on adapters as a map, kept for callers that want a lookup without
 * reading the environment. Opt-in sources are deliberately absent: whether they
 * are enabled is a per-call question (see listIntakeAdapters), not a property of
 * this Map.
 */
export const intakeAdapterRegistry: ReadonlyMap<string, IntakeAdapter> = new Map(
  ADAPTERS.map((adapter) => [adapter.sourceCode, adapter]),
);

/**
 * The environment is read PER CALL rather than captured at module load. A
 * module-level snapshot would make the flag untestable without re-importing the
 * module, and would freeze the decision at whatever the process happened to see
 * when it started.
 */
export function listIntakeAdapters(env: NodeJS.ProcessEnv = process.env): readonly IntakeAdapter[] {
  const enabled = OPT_IN.filter((entry) => isOptInIntakeEnabled(entry.flag, env)).map((entry) => entry.adapter);

  return enabled.length > 0 ? [...ADAPTERS, ...enabled] : ADAPTERS;
}

export function getIntakeAdapter(sourceCode: string, env: NodeJS.ProcessEnv = process.env): IntakeAdapter {
  const adapters = listIntakeAdapters(env);
  const adapter = adapters.find((entry) => entry.sourceCode === sourceCode);

  if (!adapter) {
    // The opt-in sources are named only when they are actually enabled, so the
    // message never lists a source the caller could not have used.
    const known = adapters.map((entry) => entry.sourceCode).join(", ");
    throw new Error(`No intake adapter registered for source_code "${sourceCode}". Registered: ${known}.`);
  }

  return adapter;
}
