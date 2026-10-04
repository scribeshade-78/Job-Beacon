import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { DEFAULT_RECOVERY_LIMIT, recoverAcceptedAttempts } from "./evidenceRecovery.js";

/**
 * Operator entry point for reconciliation.
 *
 *   npm run worker:recover-accepted            # apply
 *   npm run worker:recover-accepted -- --dry-run
 *   npm run worker:recover-accepted -- --limit=200
 *
 * AUTHORIZATION. This runs with the service-role key, exactly like the other
 * worker CLIs (worker:fit, worker:applications, worker:mailbox). It is therefore
 * an operator/backend action and must not be exposed as a route or a tool a
 * candidate session could reach. The key is read from the environment through
 * the project's own client factory — this file never prints, logs or accepts a
 * credential, and has no flag for one.
 *
 * SAFETY. It never submits anything. See evidenceRecovery.ts: no adapter import,
 * no external call, conditional and idempotent updates only.
 */

interface CliOptions {
  dryRun: boolean;
  limit: number;
}

export function parseRecoveryArgs(argv: readonly string[]): CliOptions {
  let dryRun = false;
  let limit = DEFAULT_RECOVERY_LIMIT;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      const parsed = Number.parseInt(arg.slice("--limit=".length), 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
    }
  }

  return { dryRun, limit };
}

async function main() {
  const options = parseRecoveryArgs(process.argv.slice(2));
  const client = createSupabaseServiceRoleClient();

  const result = await recoverAcceptedAttempts(client, options);

  console.log(
    "[recover-accepted] " +
      (result.dryRun ? "DRY RUN — nothing written. " : "") +
      "considered=" + result.considered +
      " finalized=" + result.finalized +
      " skipped=" + result.skipped,
  );

  for (const outcome of result.outcomes) {
    console.log(
      "[recover-accepted] " + outcome.outcome + " " + outcome.applicationAttemptId +
        (outcome.detail === undefined ? "" : " (" + outcome.detail + ")"),
    );
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("[recover-accepted] fatal", error instanceof Error ? error.message : error);
    process.exit(1);
  });
