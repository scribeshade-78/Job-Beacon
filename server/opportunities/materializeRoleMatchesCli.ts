import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import {
  DEFAULT_MATCH_BATCH_SIZE,
  DEFAULT_MATCH_MAX_BATCHES,
  materializeCandidateRoleMatches,
} from "./materializeRoleMatches.js";

/**
 * Operator entry point for role-match materialisation.
 *
 *   npm run worker:materialize-role-matches -- --candidate=<uuid>
 *   npm run worker:materialize-role-matches -- --candidate=<uuid> --dry-run
 *   npm run worker:materialize-role-matches -- --candidate=<uuid> --batch-size=500 --resume
 *
 * AUTHORIZATION. Service-role, like every other worker CLI, so this is an
 * operator action rather than a candidate-reachable route. It takes NO credential
 * argument and prints no secret. It is bounded and resumable: --batch-size caps
 * the work per database round trip and --max-batches the work per invocation,
 * NEITHER caps the corpus — the stored keyset cursor continues on the next run.
 *
 * A candidate must be named explicitly: there is no "all candidates" mode, so a
 * run cannot silently sweep every account.
 *
 * Reproducing the same operation manually is not supported by design; this is the
 * registered path.
 */

export interface CliOptions {
  candidateId: string | null;
  dryRun: boolean;
  batchSize: number;
  maxBatches: number;
}

export function parseMaterializeArgs(argv: readonly string[]): CliOptions {
  let candidateId: string | null = null;
  let dryRun = false;
  let batchSize = DEFAULT_MATCH_BATCH_SIZE;
  let maxBatches = DEFAULT_MATCH_MAX_BATCHES;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg.startsWith("--candidate=")) {
      const value = arg.slice("--candidate=".length).trim();
      candidateId = value === "" ? null : value;
      continue;
    }

    if (arg.startsWith("--batch-size=")) {
      const parsed = Number.parseInt(arg.slice("--batch-size=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) batchSize = parsed;
      continue;
    }

    if (arg.startsWith("--max-batches=")) {
      const parsed = Number.parseInt(arg.slice("--max-batches=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) maxBatches = parsed;
    }
  }

  return { candidateId, dryRun, batchSize, maxBatches };
}

async function main() {
  const options = parseMaterializeArgs(process.argv.slice(2));

  if (options.candidateId === null) {
    console.error(
      "[materialize-role-matches] --candidate=<uuid> is required. There is no all-candidates mode by design.",
    );
    process.exitCode = 2;
    return;
  }

  const client = createSupabaseServiceRoleClient();
  const result = await materializeCandidateRoleMatches(client, options.candidateId, {
    dryRun: options.dryRun,
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
  });

  console.log(
    "[materialize-role-matches] " +
      (result.dryRun ? "DRY RUN — nothing written. " : "") +
      "candidate=" + result.candidateId +
      " status=" + result.status +
      " generation=" + result.generation +
      (result.startedNewGeneration ? " (new generation)" : " (resumed)") +
      " batches=" + result.batches +
      " scanned=" + result.scanned +
      " matched=" + result.matched +
      " corpusComplete=" + result.corpusComplete,
  );

  console.log("[materialize-role-matches] roles=" + result.roles.join(", "));

  if (result.error !== undefined) {
    console.error("[materialize-role-matches] failed: " + result.error);
    console.error(
      "[materialize-role-matches] coverage is recorded as 'failed' and the previously published generation is untouched. Re-run to resume from the stored cursor.",
    );
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error("[materialize-role-matches] fatal", error instanceof Error ? error.message : error);
    process.exit(1);
  });
