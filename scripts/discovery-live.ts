#!/usr/bin/env node
/**
 * scripts/discovery-live.ts — run a real discovery pass against the live database.
 *
 * WHAT THIS IS FOR. runIngestionBatch is the candidate-triggerable "Fetch latest jobs"
 * path, and until now the only way to exercise it end to end was through the running
 * app. This drives it directly, prints what actually landed, and — unlike the app path —
 * refuses to run without an explicit target scope.
 *
 * WHY SCOPING IS MANDATORY AND NOT A CONVENIENCE.
 * runIngestionBatch takes no target filter: it enqueues EVERY enabled vacancy_sources
 * row. That set includes jooble, whose free REST plan is a LIFETIME total of 500 requests
 * — not monthly, not refillable — and the runner's own header calls a candidate-pressable
 * button that can "permanently destroy the account's remaining allowance". A script that
 * silently fires every enabled target would spend that quota as a side effect of being run
 * casually. So targets are named explicitly, and anything out of scope is disabled for the
 * duration and restored in a finally block — the restore runs even if the pass throws.
 *
 *   node --env-file=.env --import=tsx scripts/discovery-live.ts vercel leverdemo
 *   node --env-file=.env --import=tsx scripts/discovery-live.ts stripe --dedup
 *   node --env-file=.env --import=tsx scripts/discovery-live.ts --all      # loud warning
 *
 * --dedup runs a SECOND pass with the per-target cooldown forced off, re-fetching the
 * same upstream postings. That is the only way to observe deduplication from outside:
 * if the ingest layer is correct, vacancies, vacancy_source_records and vacancy_versions
 * must all stay flat, because content that has not changed must not create a new version.
 *
 * Exit code is 1 when any target failed or when nothing was in scope, so this can gate CI.
 */

import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { runIngestionBatch } from "../server/ingestion/runner.js";

/**
 * CRASH-SAFE UNDO LOG.
 *
 * Scoping a run means disabling the out-of-scope targets and restoring them in a finally.
 * A finally does not run when the process is KILLED, and that is not hypothetical: the
 * first Stripe run was killed on a 600s timeout mid-pass, left four sources disabled, and
 * would have silently stopped polling them until somebody noticed.
 *
 * So the ids being disabled are written to disk FIRST, and removed only after the restore
 * succeeds. The next invocation repairs an interrupted run before doing anything else.
 */
const UNDO_PATH = "scripts/out/discovery-live.undo.json";

let pendingRepairIds: string[] = [];

function repairInterruptedRun(): void {
  if (!existsSync(UNDO_PATH)) return;
  try {
    const ids = JSON.parse(readFileSync(UNDO_PATH, "utf8")) as string[];
    writeFileSync(UNDO_PATH + ".restoring", JSON.stringify(ids));
    console.log("!! Found an undo log from an interrupted run — restoring " + ids.length + " target(s) before continuing.");
    // The restore itself is done by the caller, which owns the client.
    pendingRepairIds = ids;
  } catch {
    console.log("!! An undo log exists but could not be parsed; leaving it in place: " + UNDO_PATH);
  }
}

interface Args {
  targets: string[];
  all: boolean;
  dedup: boolean;
}

function parseArgs(argv: string[]): Args {
  const targets: string[] = [];
  let all = false;
  let dedup = false;

  for (const arg of argv) {
    if (arg === "--all") all = true;
    else if (arg === "--dedup") dedup = true;
    else if (arg.startsWith("--")) throw new Error("Unknown flag: " + arg);
    else targets.push(arg);
  }

  if (!all && targets.length === 0) {
    throw new Error(
      "Name at least one target_key (or pass --all). Discovery is never run against every\n" +
        "enabled source by accident: the enabled set includes Jooble, whose free plan is a\n" +
        "lifetime quota a casual run can permanently spend.",
    );
  }

  return { targets, all, dedup };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  repairInterruptedRun();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (use --env-file=.env).");
  }

  const client = createClient(url, key, { auth: { persistSession: false } });

  // Repair anything a previous, killed run left disabled.
  if (pendingRepairIds.length > 0) {
    const { error: repairError } = await client.from("vacancy_sources").update({ enabled: true }).in("id", pendingRepairIds);
    if (repairError) throw repairError;
    console.log("   restored " + pendingRepairIds.length + " target(s) from the interrupted run.");
    rmSync(UNDO_PATH, { force: true });
    rmSync(UNDO_PATH + ".restoring", { force: true });
    pendingRepairIds = [];
  }

  const count = async (table: string): Promise<number> => {
    const { count: c, error } = await client.from(table).select("*", { count: "exact", head: true });
    if (error) throw error;
    return c ?? -1;
  };

  const { data: all, error: sourcesError } = await client
    .from("vacancy_sources")
    .select("id, source_code, target_key, enabled")
    .order("source_code");
  if (sourcesError) throw sourcesError;

  const enabled = (all ?? []).filter((t: any) => t.enabled);
  const requested = args.all ? enabled : enabled.filter((t: any) => args.targets.includes(t.target_key));

  // A requested target that is not enabled is a silent no-op otherwise, and "the run
  // produced nothing" would be blamed on the pipeline rather than on the request.
  const missing = args.all ? [] : args.targets.filter((k) => !enabled.some((t: any) => t.target_key === k));
  if (missing.length > 0) {
    const known = (all ?? []).map((t: any) => t.target_key + (t.enabled ? "" : " (disabled)"));
    throw new Error("No ENABLED target matches: " + missing.join(", ") + "\nKnown targets: " + known.join(", "));
  }

  const outOfScope = enabled.filter((t: any) => !requested.includes(t));

  console.log("IN SCOPE   : " + (requested.length ? requested.map((t: any) => t.source_code + "/" + t.target_key).join(", ") : "(none)"));
  if (outOfScope.length) {
    console.log("DISABLED   : " + outOfScope.map((t: any) => t.source_code + "/" + t.target_key).join(", ") + "   (restored afterwards)");
  }
  if (args.all) {
    console.log("\n!! --all includes quota-metered sources. Jooble's free plan is a LIFETIME total of");
    console.log("!! 500 requests per key and is not refillable. Only use this deliberately.\n");
  }

  if (requested.length === 0) {
    throw new Error("Nothing to run.");
  }

  const disabledIds = outOfScope.map((t: any) => t.id);
  if (disabledIds.length > 0) {
    mkdirSync(dirname(UNDO_PATH), { recursive: true });
    writeFileSync(UNDO_PATH, JSON.stringify(disabledIds, null, 1));
    rmSync(UNDO_PATH + ".restoring", { force: true });
  }
  await client.from("vacancy_sources").update({ enabled: false }).in("id", disabledIds);
  try {
    const before = { v: await count("vacancies"), r: await count("vacancy_source_records"), ver: await count("vacancy_versions") };
    console.log("\nBEFORE  vacancies=" + before.v + " source_records=" + before.r + " versions=" + before.ver);

    console.log("\n--- pass 1 (per-target cooldown honoured) ---");
    const r1 = await runIngestionBatch(client);
    report(r1);

    const mid = { v: await count("vacancies"), r: await count("vacancy_source_records"), ver: await count("vacancy_versions") };
    console.log("AFTER 1 vacancies=" + mid.v + " source_records=" + mid.r + " versions=" + mid.ver);

    if (args.dedup) {
      console.log("\n--- pass 2 (cooldown forced off; the SAME upstream postings are re-fetched) ---");
      const r2 = await runIngestionBatch(client, { minIntervalMinutes: 0 });
      report(r2);
      const after = { v: await count("vacancies"), r: await count("vacancy_source_records"), ver: await count("vacancy_versions") };
      console.log("AFTER 2 vacancies=" + after.v + " source_records=" + after.r + " versions=" + after.ver);
      console.log(
        "\nDEDUP  vacancies " + mid.v + "->" + after.v + " (delta " + (after.v - mid.v) + ")" +
          " | source_records " + mid.r + "->" + after.r + " (delta " + (after.r - mid.r) + ")" +
          " | versions " + mid.ver + "->" + after.ver + " (delta " + (after.ver - mid.ver) + ")",
      );
      if (after.v !== mid.v || after.r !== mid.r || after.ver !== mid.ver) {
        console.error("\n!! Not idempotent: identical upstream content changed row counts. See above.");
        process.exitCode = 1;
      }
    }

    const { data: rows } = await client
      .from("vacancies")
      .select("source_code, source_vacancy_id, raw_title, authoritative_url")
      .order("discovered_at", { ascending: false })
      .limit(8);
    console.log("\n--- most recently discovered ---");
    for (const v of rows ?? []) {
      console.log("  [" + v.source_code + "] " + String(v.raw_title).slice(0, 40) + "\n      " + String(v.authoritative_url).slice(0, 96));
    }

    const { data: bySrc } = await client.from("vacancies").select("source_code");
    const tally: Record<string, number> = {};
    for (const v of bySrc ?? []) tally[v.source_code] = (tally[v.source_code] ?? 0) + 1;
    console.log("\nvacancies by source: " + JSON.stringify(tally));

    if (r1.failed > 0) {
      console.error("\n!! " + r1.failed + " target(s) failed.");
      process.exitCode = 1;
    }
  } finally {
    // Order matters: re-enable FIRST, then clear the undo log. Clearing it while the rows
    // are still disabled would turn a crash here into an unrecoverable state, which is the
    // exact failure this log exists to prevent.
    if (disabledIds.length > 0) {
      await client.from("vacancy_sources").update({ enabled: true }).in("id", disabledIds);
      rmSync(UNDO_PATH, { force: true });
      console.log("\nrestored enabled=true on: " + outOfScope.map((t: any) => t.target_key).join(", "));
    }
    await client.removeAllChannels();
  }
}

function report(r: { targets: { sourceCode: string; targetKey: string; status: string; vacanciesFetched: number; lastError?: string }[]; vacanciesFetched: number; failed: number; skippedRecent: number; skippedQueued: number }): void {
  console.log("  fetched=" + r.vacanciesFetched + " failed=" + r.failed + " skippedRecent=" + r.skippedRecent + " skippedQueued=" + r.skippedQueued);
  for (const t of r.targets) {
    console.log("    " + t.sourceCode + "/" + t.targetKey + " -> " + t.status + " (" + t.vacanciesFetched + ")" + (t.lastError ? "  ERR=" + t.lastError : ""));
  }
}

// The client is created before the argument checks that can throw, so a rejection here can
// arrive while supabase-js still holds live handles. process.exit() at that moment races
// libuv's teardown and ABORTS the process on Windows (observed: exit 3221226505, an
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" from src/win/async.c) - the
// error message printed, then the exit code was a crash rather than 1. Setting exitCode
// lets the event loop drain and exit cleanly. Release the realtime channels too: they are
// never subscribed on this path, but they are the handles that keep it alive.
main().catch((error) => {
  console.error("\nFAILED: " + (error?.message ?? String(error)));
  process.exitCode = 1;
});
