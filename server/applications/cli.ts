import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { runApplicationBatch } from "./runner.js";

/**
 * MP-W1 batch worker entrypoint (`npm run worker:applications`). Single
 * pass: plan every active-candidate x verified-vacancy pair, drain
 * whatever attempts that produced, then exit — meant to be invoked by an
 * external scheduler (cron), same "no persistent process, no daemon loop"
 * position as ingestion's runOneIngestionJob. Always runs with the
 * service-role client (bypasses RLS) since this is system-initiated work,
 * not a request on behalf of one signed-in candidate.
 */
async function main() {
  const client = createSupabaseServiceRoleClient();
  const result = await runApplicationBatch(client);

  console.log("[applications:cli] batch complete", result);
}

main().catch((error) => {
  console.error("[applications:cli] fatal error", error);
  process.exitCode = 1;
});
