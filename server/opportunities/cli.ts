import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { createOpenAIClient } from "../resumes/openaiClient.js";
import { runFitAnalysisBatch } from "./runner.js";

/**
 * Response Intelligence Phase 2.1 fit-analysis worker
 * (`npm run worker:fit`). Single pass: drains fit_analysis_jobs, then
 * exits. Service-role client — system work, bypasses RLS. Safe to re-run
 * (leasing + upsert make overlapping runs harmless). No --watch, same as
 * worker:applications / worker:mailbox-match.
 */
async function main() {
  const client = createSupabaseServiceRoleClient();
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
