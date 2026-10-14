#!/usr/bin/env node
/**
 * scripts/tailoring-reliability.ts — how often does the tailoring model satisfy the honesty gate?
 *
 * WHY THIS EXISTS. The resume tailoring path can fail for a reason no unit test can see: the
 * model returns a claim with an empty factRefs array and verifyGroundedClaims refuses the whole
 * response. Every fixture in the server suite hand-writes its citations, so the suite is blind to
 * whether a LIVE model will cite anything at all. That gap shipped once already - four of four
 * real tailorings failed - and this is the instrument that measures it.
 *
 * IT EXERCISES THE REAL PATH: a real HTTP POST to POST /api/candidate/attempts/:id/generate-preview,
 * which reserves a credit, calls the real model, runs the real honesty gate and renders a real PDF.
 *
 * WHAT IT MEASURES, and the distinction matters:
 *   - passed on the first sample        the prompt did its job
 *   - passed only after the retry       the retry earned its place
 *   - failed after the retry            the number the reliability threshold is about
 *
 * IT ALSO REPORTS THE STATISTICAL BOUND, because a pass rate alone overstates what a small sample
 * proves. 20 runs with no failures is a 95% one-sided lower confidence bound of about 86%, not
 * 95%: establishing 95% at 95% confidence needs 59 consecutive passes. claim() prints the bound
 * for whatever sample it was given so the number in a review is never read as stronger than it is.
 *
 * ENVIRONMENT (all optional unless marked):
 *   JB_RELIABILITY_EMAIL       required. Candidate to sign in as.
 *   JB_RELIABILITY_PASSWORD    required.
 *   JB_RELIABILITY_VACANCY     required. The vacancy to tailor against.
 *   JB_RELIABILITY_RUNS        default 20. Total target sample size.
 *   JB_RELIABILITY_CHUNK       default 20. How many are attempted in THIS invocation; the runner
 *                              resumes, so a long sample is run as several bounded invocations.
 *   JB_RELIABILITY_API         default http://127.0.0.1:5000
 *   JB_RELIABILITY_OUT         default scripts/out/tailoring-reliability.json (gitignored)
 *   JB_RELIABILITY_SPAWN       default 1. Set 0 to use an API that is already running.
 *   JB_RELIABILITY_DB_URL      default postgresql://postgres:postgres@host.docker.internal:54322/postgres
 *
 * USAGE
 *   node --env-file-if-exists=.env --import=tsx scripts/tailoring-reliability.ts
 *
 * THE LEDGER RESET NEEDS RAW SQL, and that is a schema property rather than a shortcut.
 * service_role holds SELECT and INSERT on candidate_usage_events but NOT DELETE (verified against
 * the database), so the ledger cannot be trimmed through the service client at all. The reset
 * therefore shells out the same way deploy/preflight-schema.sh does - psql when it is on PATH,
 * otherwise a throwaway postgres container. That fallback is why the default DB URL says
 * host.docker.internal: from inside the container, 127.0.0.1 is the container.
 *
 * THE SPAWNED SERVER NEEDS A REAL ENVIRONMENT. A caller whose process.env is nearly empty (an
 * agent runner, a bare CI step) otherwise reaches Playwright with %PROGRAMFILES% undefined, and
 * it then looks for Chrome at "undefined\Program Files\Google\Chrome\Application\chrome.exe".
 * That reads exactly like a missing browser and is not one. windowsEnvironment() below is the fix.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "../server/supabaseServiceRole.js";

type Outcome = "pass_first" | "pass_retry" | "fail_uncited" | "fail_infra" | "fail_other";

/**
 * What a finished run actually tells us.
 *
 * THE DISTINCTION IS THE WHOLE POINT, and getting it wrong makes the number meaningless. Only
 * fail_uncited is a statement about the MODEL: it wrote a claim it could not cite, the retry
 * wrote one too, and the honesty gate refused both. Everything else never reached the gate.
 *
 * fail_infra is the case that prompted this split. OpenRouter answers 402 when the ACCOUNT
 * cannot afford the request's max_tokens, which surfaces as a generic 500 in under a second -
 * fast, because no model ran. Counting that as a model failure would report an account balance
 * as an instruction-following defect and fail a model that was never asked anything.
 */
function classifyOutcome(status: number, retries: number, segment: string): Outcome {
  if (status === 200) {
    return retries > 0 ? "pass_retry" : "pass_first";
  }
  // status -1 is the harness's own marker for "the request never completed" - a thrown fetch. There
  // is no server log to match against in that case, so it is caught here rather than falling
  // through to fail_other: a request that never arrived says nothing about the model either.
  if (status === -1) {
    return "fail_infra";
  }
  if (/giving up/.test(segment)) {
    return "fail_uncited";
  }
  // BOTH OpenRouter credit refusals, which are worded differently and mean different things:
  //   "requires more credits ... you requested up to 16384 tokens"  the account cannot afford the
  //                                                                reservation for ONE request
  //   "would exceed your available credits given your current       the account cannot afford the
  //    in-flight requests"                                         CONCURRENT reservations
  // The second one only appears because the resume and the cover letter run in parallel, so both
  // reserve their max_tokens at the same moment and the account must afford the SUM. Matching only
  // the first wording classified a genuine infrastructure failure as an unclassified model failure.
  if (/requires more credits|would exceed your available credits|insufficient_quota|ECONNREFUSED|fetch failed|socket hang up|ETIMEDOUT|ENOTFOUND|rate.?limit|429/i.test(segment)) {
    return "fail_infra";
  }
  return "fail_other";
}

interface RunResult {
  run: number;
  status: number;
  /** What this run proved. See classifyOutcome. */
  outcome: Outcome;
  /** How many times an infrastructure failure forced this run to be attempted again. */
  infraRetries: number;
  /** How many times the uncited-claim retry fired during this run. */
  retries: number;
  /** True when the retry ALSO failed, so the run died on a claim no citation could save. */
  gaveUp: boolean;
  ms: number;
  baseTextChars: number | null;
  tailoredTextChars: number | null;
  error: string | null;
  /**
   * The server's own log for this run, kept on failure.
   *
   * WITHOUT IT A FAILURE IS UNREADABLE. The route answers a generic 500 for every internal
   * cause - a model error, a storage error, a PDF render error - so the response body says
   * nothing about which one happened, and a fast failure and a slow one look identical from
   * outside. A 900ms 500 means nothing reached the model; a 20s one means the model ran and
   * something after it failed. The distinction is only visible here.
   */
  serverLog?: string;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  console.error("Missing required environment variable " + name + ".");
  process.exit(1);
}

/** The environment a spawned server needs on Windows, spelled out rather than inherited. */
function windowsEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    SystemDrive: "C:",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramW6432: "C:\\Program Files",
    CommonProgramFiles: "C:\\Program Files\\Common Files",
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? "C:\\Users\\user\\AppData\\Local",
    APPDATA: process.env.APPDATA ?? "C:\\Users\\user\\AppData\\Roaming",
    USERPROFILE: process.env.USERPROFILE ?? "C:\\Users\\user",
    HOME: process.env.HOME ?? "C:\\Users\\user",
    TEMP: process.env.TEMP ?? "C:\\Users\\user\\AppData\\Local\\Temp",
    TMP: process.env.TMP ?? "C:\\Users\\user\\AppData\\Local\\Temp",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PROCESSOR_ARCHITECTURE: "AMD64",
  };
}

/** Run one SQL statement against the fixture database, via psql or a throwaway container. */
function runSql(dbUrl: string, sql: string): void {
  const onPath = spawnSync("psql", ["--version"], { encoding: "utf8" });
  const result =
    onPath.status === 0
      ? spawnSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], { encoding: "utf8" })
      : spawnSync("docker", ["run", "--rm", "postgres:17-alpine", "psql", dbUrl, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], {
          encoding: "utf8",
        });

  if (result.status !== 0) {
    throw new Error("SQL failed: " + (result.stderr || result.error?.message || "unknown").slice(0, 300));
  }
}

/** P(X <= k) for X ~ Binomial(n, p). Used for the exact lower bound below. */
function binomialCdf(k: number, n: number, p: number): number {
  let logChoose = 0;
  let total = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) {
      logChoose += Math.log((n - i + 1) / i);
    }
    total += Math.exp(logChoose + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return total;
}

/**
 * The one-sided 95% lower confidence bound on the pass rate (Clopper-Pearson).
 *
 * The smallest p for which observing at most this many failures would be a 5% event. Reported
 * because "20/20 passed" and "the true rate is at least 95%" are different claims, and only the
 * first is what a small sample actually supports.
 */
function lowerBound95(failures: number, n: number): number {
  if (n === 0) return 0;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 80; step += 1) {
    const mid = (low + high) / 2;
    if (Math.max(1 - binomialCdf(failures, n, mid), 1e-12) > 0.05) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return low;
}

async function main(): Promise<void> {
  const email = readEnv("JB_RELIABILITY_EMAIL");
  const password = readEnv("JB_RELIABILITY_PASSWORD");
  const vacancyId = readEnv("JB_RELIABILITY_VACANCY");
  const targetRuns = Number(readEnv("JB_RELIABILITY_RUNS", "20"));
  const chunk = Number(readEnv("JB_RELIABILITY_CHUNK", "20"));
  const apiBase = readEnv("JB_RELIABILITY_API", "http://127.0.0.1:5000");
  const outPath = readEnv("JB_RELIABILITY_OUT", "scripts/out/tailoring-reliability.json");
  const shouldSpawn = readEnv("JB_RELIABILITY_SPAWN", "1") !== "0";
  const dbUrl = readEnv("JB_RELIABILITY_DB_URL", "postgresql://postgres:postgres@host.docker.internal:54322/postgres");
  /** How many times one run may be re-attempted after an infrastructure failure. */
  const infraRetriesAllowed = Number(readEnv("JB_RELIABILITY_INFRA_RETRIES", "5"));

  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    console.error("Missing SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY).");
    process.exit(1);
  }

  const service = createSupabaseServiceRoleClient();
  const anon = createClient(process.env.SUPABASE_URL ?? "", publishableKey, { auth: { persistSession: false } });

  const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError || !session.user) {
    console.error("Could not sign in as " + email + ": " + (signInError?.message ?? "no session"));
    process.exit(1);
  }
  const candidateId = session.user.id;

  const previous: RunResult[] = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as RunResult[]) : [];
  // JB_RELIABILITY_RETRY_FAILED=1 RE-RUNS ONLY THE RUNS THAT FAILED, with the server log
  // captured. A failure that cannot be reproduced on demand is a failure nobody can diagnose,
  // and re-running the whole sample to see one of them again wastes the good runs.
  const retryFailed = readEnv("JB_RELIABILITY_RETRY_FAILED", "0") === "1";
  const done = new Set(previous.map((row) => row.run));
  const pending: number[] = [];
  if (retryFailed) {
    for (const row of previous) {
      if (row.status !== 200 && pending.length < chunk) pending.push(row.run);
    }
  } else {
    for (let run = 1; run <= targetRuns && pending.length < chunk; run += 1) {
      if (!done.has(run)) {
        pending.push(run);
      }
    }
  }

  if (pending.length === 0) {
    console.log("All " + targetRuns + " runs are already recorded in " + outPath + ".");
  }

  // ONE PLAN, A FRESH ATTEMPT PER RUN. A new attempt id means a new credit reservation key AND an
  // attempt with no prepared document - which is the code path that actually calls the model.
  for (const plan of (await service.from("application_plans").select("id").eq("candidate_id", candidateId).eq("vacancy_id", vacancyId)).data ?? []) {
    await service.from("application_attempts").delete().eq("application_plan_id", (plan as { id: string }).id);
  }
  await service.from("application_plans").delete().eq("candidate_id", candidateId).eq("vacancy_id", vacancyId);
  const { data: plan, error: planError } = await service
    .from("application_plans")
    .insert({ candidate_id: candidateId, vacancy_id: vacancyId, gate_results: {} })
    .select("id")
    .single();
  if (planError) {
    console.error("Could not create the fixture plan: " + planError.message);
    process.exit(1);
  }

  let serverOutput = "";
  const server = shouldSpawn
    ? spawn(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", "server/index.ts"], {
        cwd: process.cwd(),
        env: windowsEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      })
    : null;
  server?.stdout.on("data", (data) => {
    serverOutput += data;
  });
  server?.stderr.on("data", (data) => {
    serverOutput += data;
  });

  const results = [...previous];

  try {
    if (server) {
      let healthy = false;
      for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
        try {
          if ((await fetch(apiBase + "/api/health")).ok) healthy = true;
        } catch {
          // not up yet
        }
        if (!healthy) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!healthy) {
        console.error("The API never became healthy at " + apiBase + ".\n" + serverOutput.slice(-1200));
        process.exit(1);
      }
    }

    // FAIL FAST ON AN ENVIRONMENT BLOCKER. Once requests are being refused for reasons that have
    // nothing to do with the model - a spent API balance, a dead network - grinding through the
    // rest of the sample burns wall-clock and tells nobody anything. Three consecutive runs that
    // could not complete even after their infrastructure retries is enough to stop and say so.
    let consecutiveInfraFailures = 0;

    for (const run of pending) {
      // THE FREE PLAN GRANTS 2 CREDITS A MONTH, so the local ledger is re-granted before every run.
      // Local fixture state only; it is what makes a sample larger than two possible at all.
      runSql(dbUrl, "delete from candidate_usage_events where candidate_id='" + candidateId + "';");

      const { data: attempt, error: attemptError } = await service
        .from("application_attempts")
        .insert({ application_plan_id: (plan as { id: string }).id, status: "pending_review" })
        .select("id")
        .single();
      if (attemptError) {
        console.error("Could not create the fixture attempt: " + attemptError.message);
        process.exit(1);
      }

      // AN INFRASTRUCTURE FAILURE IS RE-ATTEMPTED, because it carries no information about the
      // model. Re-running the whole sample to replace one 402 would waste the good runs, and
      // counting it as a model failure would report the account balance as a model defect.
      let result: RunResult | null = null;
      let infraRetries = 0;

      for (let attemptNumber = 1; attemptNumber <= infraRetriesAllowed && result === null; attemptNumber += 1) {
        if (attemptNumber > 1) {
          // Fresh attempt id (a new reservation key) and a fresh ledger, same as any other run.
          runSql(dbUrl, "delete from candidate_usage_events where candidate_id='" + candidateId + "';");
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }

        const logOffset = serverOutput.length;
        const startedAt = Date.now();
        let status = -1;
        let body: { resume?: { baseText?: string | null; tailoredText?: string | null }; error?: string; code?: string } = {};
        try {
          const response = await fetch(apiBase + "/api/candidate/attempts/" + (attempt as { id: string }).id + "/generate-preview", {
            method: "POST",
            headers: { Authorization: "Bearer " + session.session.access_token },
          });
          status = response.status;
          body = (await response.json()) as typeof body;
        } catch (error) {
          body = { error: error instanceof Error ? error.message : String(error) };
        }
        const ms = Date.now() - startedAt;

        const segment = serverOutput.slice(logOffset);
        const retries = (segment.match(/uncited claim; retrying once/g) ?? []).length;
        const outcome = classifyOutcome(status, retries, segment);

        if (outcome === "fail_infra" && attemptNumber < infraRetriesAllowed) {
          infraRetries += 1;
          console.log("  run " + String(run).padStart(3) + ": infrastructure failure (" + ms + "ms), re-attempting " + attemptNumber + "/" + (infraRetriesAllowed - 1));
          continue;
        }

        result = {
          run,
          status,
          outcome,
          infraRetries,
          retries,
          gaveUp: /giving up/.test(segment),
          ms,
          baseTextChars: body.resume?.baseText ? body.resume.baseText.length : null,
          tailoredTextChars: body.resume?.tailoredText ? body.resume.tailoredText.length : null,
          error: status === 200 ? null : JSON.stringify(body).slice(0, 180),
          ...(status === 200 ? {} : { serverLog: segment.slice(-900) }),
        };
      }

      if (result === null) {
        console.error("Unreachable: the attempt loop always assigns a result.");
        process.exit(1);
      }

      consecutiveInfraFailures = result.outcome === "fail_infra" ? consecutiveInfraFailures + 1 : 0;
      if (consecutiveInfraFailures >= 3) {
        const existingIndex = results.findIndex((row) => row.run === run);
        if (existingIndex >= 0) {
          results[existingIndex] = result;
        } else {
          results.push(result);
        }
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(results, null, 1));

        console.error("");
        console.error("STOPPING: three consecutive runs could not complete for infrastructure reasons.");
        console.error("Last server log: " + (result.serverLog ?? "(none)").slice(0, 400));
        console.error("This is an environment blocker, not a model finding - the honesty gate was");
        console.error("never reached. Fix the cause above and re-run; the sample resumes where it stopped.");
        process.exit(2);
      }

      const existingIndex = results.findIndex((row) => row.run === run);
      if (existingIndex >= 0) {
        results[existingIndex] = result;
      } else {
        results.push(result);
      }

      // WRITTEN AFTER EVERY RUN, so a timeout or a crash costs at most one observation.
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(results, null, 1));

      const label = result.outcome === "pass_first" ? "pass (first try)"
        : result.outcome === "pass_retry" ? "pass (via retry)"
        : result.outcome === "fail_uncited" ? "FAIL (uncited)"
        : result.outcome === "fail_infra" ? "fail (infra)"
        : "FAIL (other)";
      console.log(
        "  run " + String(run).padStart(3) + ": " + label.padEnd(17) + " http=" + String(result.status).padEnd(4) + String(result.ms).padStart(6) + "ms" +
          (result.error ? "\n           " + result.error : "") +
          (result.serverLog ? "\n           log: " + result.serverLog.split("\n").filter((l) => l.trim()).slice(-3).join(" | ").slice(0, 400) : ""),
      );
    }
  } finally {
    server?.kill();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const sample = results.filter((row) => row.run <= targetRuns);
  const count = (outcome: Outcome) => sample.filter((row) => row.outcome === outcome).length;

  const firstTry = count("pass_first");
  const viaRetry = count("pass_retry");
  const failedUncited = count("fail_uncited");
  const failedInfra = count("fail_infra");
  const failedOther = count("fail_other");
  const passed = firstTry + viaRetry;

  // THE THRESHOLD IS EVALUATED ON MODEL FAILURES ONLY, and that is the difference between a
  // measurement and a number. An infrastructure failure never reached the honesty gate, so
  // grading it would report the API account's balance as an instruction-following defect and
  // condemn a model that was never asked anything. Those runs are re-attempted inside the loop;
  // whatever remains here could not be completed for reasons outside the model, so they are
  // reported and excluded from the denominator rather than quietly dropped.
  const graded = sample.filter((row) => row.outcome !== "fail_infra");
  const times = graded.map((row) => row.ms).sort((a, b) => a - b);
  const infraRetryTotal = sample.reduce((total, row) => total + (row.infraRetries ?? 0), 0);

  console.log("");
  console.log("=== TAILORING RELIABILITY: " + sample.length + " / " + targetRuns + " runs recorded ===");
  console.log("  passed                : " + passed + " / " + sample.length);
  console.log("    on the first sample : " + firstTry);
  console.log("    via the retry       : " + viaRetry);
  console.log("  failed ON THE GATE     : " + failedUncited + "   <- the only number the threshold is about");
  console.log("  incomplete (infra)    : " + failedInfra + (failedInfra > 0 ? "   <- the API account, not the model" : ""));
  if (failedOther > 0) {
    console.log("  failed, unclassified  : " + failedOther + "   <- inspect the results file");
  }
  if (infraRetryTotal > 0) {
    console.log("  infrastructure retries: " + infraRetryTotal);
  }
  if (times.length > 0) {
    console.log("  latency min/median/max: " + times[0] + "ms / " + times[Math.floor(times.length / 2)] + "ms / " + times[times.length - 1] + "ms");
  }
  if (graded.length > 0) {
    const bound = lowerBound95(failedUncited, graded.length);
    console.log("");
    console.log("  gate pass rate        : " + ((passed / graded.length) * 100).toFixed(1) + "% of " + graded.length + " completed runs");
    console.log("  one-sided 95% lower bound: " + (bound * 100).toFixed(1) + "%   (Clopper-Pearson)");
    const needed = Math.ceil(Math.log(0.05) / Math.log(0.95));
    if (bound < 0.95) {
      console.log("  " + Math.max(needed - graded.length, 0) + " more failure-free completed runs puts the bound at or above 95%.");
    }
    console.log("  results file          : " + outPath);
  }
}

await main();
