import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Mini-Phase 9 acceptance check (`npm run mcp:smoke`).
 *
 * Spawns the MCP server exactly as an external agent would — a child process
 * over stdio — then performs the real handshake: initialize, the initialized
 * notification, tools/list, and a tools/call for the pipeline state. Nothing
 * here imports the server's modules or reaches into its internals, so a pass
 * means the wire protocol works, not merely that the functions do.
 *
 * Follows server/ingestion/joobleSmoke.ts's precedent: a one-shot script that
 * exercises a real integration and exits non-zero on failure, rather than a
 * unit test that would have to fake the transport it is meant to verify.
 *
 * Exits 0 on success, 1 on any failure.
 */

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

function fail(message: string): never {
  console.error(`\n[smoke] FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "--import=tsx", serverEntry],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let nextId = 1;

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      // stdout is the protocol channel; anything else on it is a real defect.
      fail(`non-JSON output on stdout (the protocol channel): ${trimmed.slice(0, 200)}`);
    }

    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  });

  // The server logs to stderr by design; surface it prefixed rather than
  // letting it interleave with this script's own output.
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk.toString()}`));

  function request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`${method} timed out after 30s`));
        }
      }, 30_000);
    });
  }

  function notify(method: string, params: unknown): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  // 1. initialize
  const initialize = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "jobbeacon-smoke", version: "0.1.0" },
  });

  if (initialize.error) fail(`initialize returned an error: ${JSON.stringify(initialize.error)}`);

  const handshake = initialize.result as {
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo: { name: string; version: string };
  };

  console.log("initialize ->");
  console.log("  serverInfo:      ", JSON.stringify(handshake.serverInfo));
  console.log("  protocolVersion: ", handshake.protocolVersion);
  console.log("  capabilities:    ", JSON.stringify(handshake.capabilities));

  // 2. initialized notification (no response expected)
  notify("notifications/initialized", {});

  // 3. tools/list
  const list = await request("tools/list", {});
  if (list.error) fail(`tools/list returned an error: ${JSON.stringify(list.error)}`);

  const listed = (list.result as { tools: Array<{ name: string; description?: string }> }).tools;
  console.log("\ntools/list ->", JSON.stringify(listed.map((tool) => tool.name)));

  for (const expected of ["get_candidate_pipeline", "get_opportunity_details", "queue_applications"]) {
    if (!listed.some((tool) => tool.name === expected)) {
      fail(`tools/list did not include ${expected}`);
    }
  }

  // 4. tools/call — the pipeline state
  const call = await request("tools/call", { name: "get_candidate_pipeline", arguments: {} });
  if (call.error) fail(`tools/call returned a JSON-RPC error: ${JSON.stringify(call.error)}`);

  const result = call.result as { content: Array<{ type: string; text: string }>; isError?: boolean };

  if (result.isError) fail(`tools/call reported isError: ${result.content[0]?.text}`);

  const payload = JSON.parse(result.content[0].text) as {
    candidateId: string;
    totalApplications: number;
    stages: Array<{ stage: string; label: string; count: number; applications?: Array<{ vacancyId: string }> }>;
  };

  console.log("\ntools/call get_candidate_pipeline ->");
  console.log("  candidateId:      ", payload.candidateId);
  console.log("  totalApplications:", payload.totalApplications);
  for (const stage of payload.stages) {
    console.log(`  ${stage.label.padEnd(12)} ${stage.count}`);
  }

  const categorized = payload.stages.filter((stage) => stage.stage !== "all");
  const summed = categorized.reduce((total, stage) => total + stage.count, 0);

  if (summed !== payload.totalApplications) {
    fail(`stage counts sum to ${summed} but All is ${payload.totalApplications} — the partition leaked`);
  }

  // 5. a tool call that fails must come back in-band, not as a transport error
  const badCall = await request("tools/call", {
    name: "get_opportunity_details",
    arguments: { vacancy_id: "00000000-0000-4000-8000-000000000000" },
  });
  const badResult = badCall.result as { isError?: boolean; content: Array<{ text: string }> };

  if (!badResult?.isError) fail("a missing vacancy should have produced an in-band isError result");
  console.log("\nmissing-vacancy call -> isError:", badResult.isError, "|", badResult.content[0].text.slice(0, 90));

  // 6. queue_applications — the write tool.
  //
  // Deliberately aimed at a vacancy that ALREADY has a succeeded attempt, so
  // the call is idempotent: planApplication reuses the active attempt and no
  // row is written. Pointing it at an arbitrary vacancy would leave a plan
  // behind in a real database every time this smoke test ran, which is not
  // something a repeatable check should do.
  const appliedVacancyId = payload.stages.find((stage) => stage.stage === "applied")?.applications?.[0]?.vacancyId;

  if (!appliedVacancyId) {
    console.log("\nqueue_applications -> skipped (no already-applied vacancy to target safely)");
  } else {
    const queueCall = await request("tools/call", {
      name: "queue_applications",
      arguments: { vacancy_ids: [appliedVacancyId] },
    });

    if (queueCall.error) fail(`queue_applications returned a JSON-RPC error: ${JSON.stringify(queueCall.error)}`);

    const queueResult = queueCall.result as { content: Array<{ text: string }>; isError?: boolean };

    if (queueResult.isError) fail(`queue_applications reported isError: ${queueResult.content[0]?.text}`);

    const outcome = JSON.parse(queueResult.content[0].text) as {
      requested: number;
      queued: number;
      blocked: number;
      errors: number;
      outcomes: Array<{ vacancyId: string; status: string; blockingGates: unknown[] }>;
    };

    console.log("\ntools/call queue_applications ->");
    console.log(`  requested: ${outcome.requested} | queued: ${outcome.queued} | blocked: ${outcome.blocked} | errors: ${outcome.errors}`);

    for (const entry of outcome.outcomes) {
      console.log(`  ${entry.vacancyId} -> ${entry.status}`);
    }

    // The same four counters the HTTP route returns — the whole point of the
    // tool is that it is the same engine path, not a second implementation.
    for (const field of ["requested", "queued", "blocked", "errors"] as const) {
      if (typeof outcome[field] !== "number") fail(`queue_applications outcome is missing the "${field}" counter`);
    }

    if (outcome.requested !== 1) fail(`expected requested: 1, got ${outcome.requested}`);
    if (outcome.queued !== 1) fail(`expected the already-applied vacancy to come back queued, got ${outcome.queued}`);
  }

  child.stdin.end();
  child.kill();

  console.log("\n[smoke] PASS — initialize, tools/list and tools/call all succeeded over stdio.");
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
