import type OpenAI from "openai";
import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { createOpenAIClient } from "../resumes/openaiClient.js";
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

  // Optional: without OPENROUTER_API_KEY the poll still runs and stores
  // messages — classification is left to `npm run worker:mailbox-classify`.
  let openaiClient: OpenAI | undefined;
  try {
    openaiClient = createOpenAIClient();
  } catch (error) {
    console.warn("[mailbox:cli] classification disabled this run:", error instanceof Error ? error.message : error);
  }

  const result = await runMailboxPollingBatch(client, config, encryptionKey, fetch, openaiClient);

  console.log("[mailbox:cli] batch complete", result);
}

main().catch((error) => {
  console.error("[mailbox:cli] fatal error", error);
  process.exitCode = 1;
});
