/**
 * Reads a non-negative integer from the environment, falling back when the
 * variable is absent, unparseable, or negative.
 *
 * Extracted so the two long-running entry points (applications/daemon.ts and
 * scheduler.ts) cannot drift apart on what "an interval from the environment"
 * means. A negative or NaN interval is never honoured: it would either mean
 * "never run" or a busy loop, and neither is something a typo should be able to
 * configure. Zero IS honoured, because "run flat out" is a legitimate choice for
 * a local drain and is what DEFAULT_BUSY_INTERVAL_MS already encodes.
 */
export function readEnvInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name];

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
