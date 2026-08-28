import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { createOpenAIClient } from "../resumes/openaiClient.js";
import { runMessageClassificationBatch } from "./classifyBatch.js";

/**
 * Response Intelligence backfill/retry worker (`npm run worker:mailbox-classify`).
 * Single pass: classifies `messages` rows that still have no
 * response_classifications row, then exits — same "no daemon loop"
 * position as the other workers. Fresh mail is normally classified inline
 * during poll; this catches the backlog and any poll-time failures.
 * Service-role client (system work, bypasses RLS).
 */
async function main() {
  const client = createSupabaseServiceRoleClient();
  const openaiClient = createOpenAIClient();

  const limit = process.env.MESSAGE_CLASSIFY_BATCH_LIMIT
    ? Number.parseInt(process.env.MESSAGE_CLASSIFY_BATCH_LIMIT, 10)
    : undefined;

  const result = await runMessageClassificationBatch(client, openaiClient, { limit });

  console.log("[mailbox:classify] batch complete", result);
}

main().catch((error) => {
  console.error("[mailbox:classify] fatal error", error);
  process.exitCode = 1;
});
