import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { runApplicationMatchBatch } from "./matchBatch.js";

/**
 * Response Intelligence application-matching worker
 * (`npm run worker:mailbox-classify` classifies; this links). Single
 * pass: sweeps classified-but-unlinked messages and links each to one of
 * the owning candidate's application attempts, then exits. Service-role
 * client — system work, bypasses RLS. Safe to re-run: only touches rows
 * where application_attempt_id IS NULL.
 */
async function main() {
  const client = createSupabaseServiceRoleClient();

  const limit = process.env.MESSAGE_MATCH_BATCH_LIMIT
    ? Number.parseInt(process.env.MESSAGE_MATCH_BATCH_LIMIT, 10)
    : undefined;

  const result = await runApplicationMatchBatch(client, { limit });

  console.log("[mailbox:match] batch complete", result);
}

main().catch((error) => {
  console.error("[mailbox:match] fatal error", error);
  process.exitCode = 1;
});
