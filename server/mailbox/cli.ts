import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { readGoogleOAuthConfig } from "./oauth.js";
import { readMailboxEncryptionKey } from "./tokenCrypto.js";
import { runMailboxPollingBatch } from "./poll.js";

/**
 * R6.2 batch worker entrypoint (`npm run worker:mailbox`). Single pass:
 * claims every due `connected` mailbox_connections row, polls each for new
 * Gmail messages, then exits — same "no persistent process, no daemon
 * loop" position as applications/cli.ts and the ingestion worker. Always
 * runs with the service-role client (bypasses RLS) since this is
 * system-initiated work, not a request on behalf of one signed-in candidate.
 */
async function main() {
  const client = createSupabaseServiceRoleClient();
  const config = readGoogleOAuthConfig();
  const encryptionKey = readMailboxEncryptionKey();

  const result = await runMailboxPollingBatch(client, config, encryptionKey);

  console.log("[mailbox:cli] batch complete", result);
}

main().catch((error) => {
  console.error("[mailbox:cli] fatal error", error);
  process.exitCode = 1;
});
