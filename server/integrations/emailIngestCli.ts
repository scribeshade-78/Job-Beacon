import { readFile } from "node:fs/promises";
import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { createOpenAIClient } from "../resumes/openaiClient.js";
import { ingestEmailResponse } from "./emailParser.js";

/**
 * Task Z CLI — ingest one raw email payload for one candidate.
 *
 *   npm run email:ingest -- --candidate <uuid> --file ./rejection.json
 *   npm run email:ingest -- --candidate <uuid> --file ./interview.txt
 *
 * Accepts a JSON object or a raw RFC822-ish text file (see
 * parseRawEmailPayload). Prints the classification, the matched application and
 * the stage that application now sits in — read back from the database, not
 * asserted here.
 *
 * Uses the service-role client, like every other worker entry point: this is
 * system-initiated ingestion, not a request on behalf of a signed-in candidate.
 */

function readArg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

async function main(): Promise<void> {
  const candidateId = readArg("candidate");
  const file = readArg("file");

  if (!candidateId || !file) {
    console.error("Usage: npm run email:ingest -- --candidate <uuid> --file <path>");
    console.error("");
    console.error("  --candidate  candidate_profiles.id the email belongs to");
    console.error("  --file       a .json object or a .txt / .eml raw email");
    process.exitCode = 1;
    return;
  }

  const contents = await readFile(file, "utf8");

  // A .json file is passed through as an object; anything else is treated as
  // raw text, which parseRawEmailPayload reads as RFC822-ish headers + body.
  const raw = file.toLowerCase().endsWith(".json") ? JSON.parse(contents) : contents;

  const client = createSupabaseServiceRoleClient();
  const result = await ingestEmailResponse(client, createOpenAIClient(), { candidateId, raw });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
