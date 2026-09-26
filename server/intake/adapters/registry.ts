import type { IntakeAdapter } from "./types.js";
import { remotiveIntakeAdapter } from "./remotive.js";
import { arbeitnowIntakeAdapter } from "./arbeitnow.js";
import { joobleIntakeAdapter } from "./joobleIntake.js";
import { adzunaIntakeAdapter } from "./adzunaIntake.js";
import { theMuseIntakeAdapter } from "./themuse.js";
import { readSerpApiKey, serpapiIntakeAdapter } from "./serpapi.js";

/**
 * Registry of on-demand intake adapters.
 *
 * Separate from server/ingestion/adapters/registry.ts on purpose — see
 * ./types.ts for why the two contracts are adjacent rather than unified. Adding
 * an adapter here does NOT make it pollable by the scheduled ingestion worker;
 * that still requires a DiscoveryAdapter plus a vacancy_sources row.
 */
/**
 * Order is the fan-out's execution order, and it is deliberate: the two keyless
 * sources run first, because they need neither a credential nor any candidate
 * context and therefore still return listings when the credentialed aggregators
 * are skipped for a missing preference. A run that ends with nothing is then at
 * least known to have tried the sources that cannot fail for configuration
 * reasons.
 */
const ADAPTERS: readonly IntakeAdapter[] = [
  remotiveIntakeAdapter,
  arbeitnowIntakeAdapter,
  joobleIntakeAdapter,
  adzunaIntakeAdapter,
];

/**
 * The env flag that opts The Muse in. Named as a constant so the adapter, the
 * registry and the tests cannot disagree about its spelling.
 */
export const THE_MUSE_INTAKE_FLAG = "THE_MUSE_INTAKE_ENABLED";

/**
 * SerpApi's opt-in flag. This source needs TWO conditions rather than one, which
 * is why the OPT_IN entries below carry a predicate instead of a flag name.
 */
export const SERPAPI_INTAKE_FLAG = "SERPAPI_INTAKE_ENABLED";

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
const OPT_IN: ReadonlyArray<{ adapter: IntakeAdapter; isEnabled: (env: NodeJS.ProcessEnv) => boolean }> = [
  { adapter: theMuseIntakeAdapter, isEnabled: (env) => isOptInIntakeEnabled(THE_MUSE_INTAKE_FLAG, env) },
  /**
   * SerpApi requires the flag AND a key, unlike The Muse, and the quota is the
   * reason: 100 searches per MONTH is the tightest budget in this fan-out by two
   * orders of magnitude. A flag alone would let an operator enable the source
   * against a deployment with no credential, so every candidate click would
   * report a skipped source. The key is only presence-checked here; the adapter
   * reads it.
   */
  {
    adapter: serpapiIntakeAdapter,
    isEnabled: (env) => isOptInIntakeEnabled(SERPAPI_INTAKE_FLAG, env) && readSerpApiKey(env) !== undefined,
  },
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

/** The flag alone is not enough — see the OPT_IN entry for why a key is required too. */
export function isSerpApiIntakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptInIntakeEnabled(SERPAPI_INTAKE_FLAG, env) && readSerpApiKey(env) !== undefined;
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
  const enabled = OPT_IN.filter((entry) => entry.isEnabled(env)).map((entry) => entry.adapter);

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
