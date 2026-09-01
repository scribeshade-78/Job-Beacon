import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { createOpenAIClient } from "../resumes/openaiClient.js";
import { runFitAnalysisBatch } from "./runner.js";
import { reconcileFitAnalyses } from "./reconcile.js";

/**
 * Response Intelligence Phase 2.1 fit-analysis worker
 * (`npm run worker:fit`). Single pass: drains fit_analysis_jobs, then
 * exits. Service-role client — system work, bypasses RLS. Safe to re-run
 * (leasing + upsert make overlapping runs harmless). No --watch, same as
 * worker:applications / worker:mailbox-match.
 *
 * Phase 2.3c adds `npm run worker:fit -- --reconcile`: enqueue-only, no
 * drain and no OpenAI client. It re-arms every active candidate x verified
 * vacancy pair whose stored priority score is missing or written under an
 * older score version; the next ordinary run drains what it queued.
 */
async function main() {
  const client = createSupabaseServiceRoleClient();

  if (process.argv.includes("--reconcile")) {
    const limit = process.env.FIT_RECONCILE_LIMIT
      ? Number.parseInt(process.env.FIT_RECONCILE_LIMIT, 10)
      : undefined;

    const result = await reconcileFitAnalyses(client, { limit });

    console.log("[opportunities:fit] reconcile complete", result);
    if (result.truncated) {
      console.log("[opportunities:fit] limit reached — run --reconcile again to continue");
    }
    return;
  }

  const openai = createOpenAIClient();

  const maxPerBatch = process.env.FIT_ANALYSIS_BATCH_LIMIT
    ? Number.parseInt(process.env.FIT_ANALYSIS_BATCH_LIMIT, 10)
    : undefined;

  const result = await runFitAnalysisBatch(client, { openai }, { maxPerBatch });

  console.log("[opportunities:fit] batch complete", result);
}

main().catch((error) => {
  console.error("[opportunities:fit] fatal error", error);
  process.exitCode = 1;
});
