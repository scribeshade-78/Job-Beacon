import { readEnvInt } from "../config/envInt.js";

/**
 * How many fit analyses ONE drain may claim, and the ceiling no environment may exceed.
 *
 * WHY A CEILING RATHER THAN A REQUIRED VARIABLE. Every fit analysis is a paid model call, so
 * this number is what meters the AI bill. A variable that is merely REQUIRED meters nothing:
 * set it to 100000 and the drain spends that in one tick while the config looks correct. The
 * bound has to live in code, where a config file cannot raise it.
 *
 * 50 IS THE THROTTLE. At a five-minute cadence that is at most 14,400 analyses a day if the
 * queue is never empty — real money, but bounded and predictable.
 *
 * 200 IS THE CEILING, and it is not arbitrary: it is one fan-out's worth, matching the
 * 200-vacancy cap in migration 20261016090000, so a single tick can never spend more than one
 * candidate action queued. Reconcile may queue 500 in a pass; the drain is what meters the
 * spending.
 *
 * SHARED BY BOTH ENTRY POINTS — the scheduled task and npm run worker:fit — so the scheduled
 * and manual paths cannot throttle differently.
 */
export const DEFAULT_FIT_ANALYSIS_BATCH_LIMIT = 50;
export const MAX_FIT_ANALYSIS_BATCH_LIMIT = 200;

/**
 * The effective per-tick limit.
 *
 * 0 IS HONOURED and means "claim nothing": readEnvInt deliberately treats zero as a value
 * rather than a typo, and here that is a way to stop the paid drain without disabling the
 * task or unsetting the key. An absent, empty, unparseable or negative value falls back to
 * the default rather than uncapping.
 */
export function readFitAnalysisBatchLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.min(
    readEnvInt("FIT_ANALYSIS_BATCH_LIMIT", DEFAULT_FIT_ANALYSIS_BATCH_LIMIT, env),
    MAX_FIT_ANALYSIS_BATCH_LIMIT,
  );
}
