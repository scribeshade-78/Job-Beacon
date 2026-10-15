import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFitAnalysisBatch } from "./opportunities/runner.js";
import { reconcileFitAnalyses } from "./opportunities/reconcile.js";
import { runFollowUpSweep } from "./mailbox/antiGhosting.js";
import { drainIntakeRefreshJobs } from "./intake/refreshQueue.js";
import { drainIngestionJobs, enqueueIngestionBatch } from "./ingestion/runner.js";
import {
  KEYLESS_SCHEDULED_SOURCE_CODES,
  runScheduledRankingRefresh,
} from "./opportunities/scheduledRefresh.js";
import {
  ANTI_GHOSTING_TASK_NAME,
  buildScheduledTasks,
  CALENDAR_SYNC_TASK_NAME,
  DEFAULT_ANTI_GHOSTING_INTERVAL_MS,
  DEFAULT_FIT_INTERVAL_MS,
  DEFAULT_FIT_RECONCILE_INTERVAL_MS,
  DEFAULT_RANKING_REFRESH_INTERVAL_MS,
  DEFAULT_INGESTION_DRAIN_INTERVAL_MS,
  DEFAULT_INTAKE_REFRESH_DRAIN_INTERVAL_MS,
  DEFAULT_KEYLESS_INGESTION_INTERVAL_MS,
  FIT_RECONCILE_TASK_NAME,
  FIT_TASK_NAME,
  INGESTION_DRAIN_TASK_NAME,
  INTAKE_REFRESH_DRAIN_TASK_NAME,
  KEYLESS_INGESTION_ENQUEUE_TASK_NAME,
  MAILBOX_CLASSIFY_TASK_NAME,
  MAILBOX_MATCH_TASK_NAME,
  MAILBOX_POLL_TASK_NAME,
  parseDisabledTasks,
  RANKING_REFRESH_TASK_NAME,
} from "./schedulerTasks.js";

vi.mock("./opportunities/runner.js", () => ({ runFitAnalysisBatch: vi.fn() }));
// The back-fill. Its own logic - which pairs are stale, the truncation flag - is
// covered by server/opportunities/reconcile.test.ts; here only registration,
// cadence, ordering and what the scheduler hands it.
vi.mock("./opportunities/reconcile.js", () => ({ reconcileFitAnalyses: vi.fn() }));
vi.mock("./mailbox/poll.js", () => ({ runMailboxPollingBatch: vi.fn() }));
vi.mock("./mailbox/classifyBatch.js", () => ({ runMessageClassificationBatch: vi.fn() }));
vi.mock("./mailbox/matchBatch.js", () => ({ runApplicationMatchBatch: vi.fn() }));
vi.mock("./calendar/sync.js", () => ({ runCalendarSyncBatch: vi.fn() }));
// The ingestion drain reaches the network through its own client. Nothing in this file
// exercises a real fetch, so the runner is mocked rather than handed the {} client.
vi.mock("./ingestion/runner.js", () => ({
  drainIngestionJobs: vi.fn(),
  enqueueIngestionBatch: vi.fn(),
}));

// The candidate-scoped refresh queue. Its own coordination - the lease, the fit
// re-home, the failure isolation - is covered by server/intake/refreshQueue.test.ts;
// here only registration, cadence and what the scheduler hands it.
vi.mock("./intake/refreshQueue.js", () => ({ drainIntakeRefreshJobs: vi.fn() }));

// Batch C. The tasks' own coordination is covered by
// server/opportunities/scheduledRefresh.test.ts; here only registration, cadence
// and the summary the scheduler logs.
vi.mock("./opportunities/scheduledRefresh.js", async (importActual) => {
  const actual = await importActual<typeof import("./opportunities/scheduledRefresh.js")>();
  return {
    ...actual,
    runScheduledRankingRefresh: vi.fn(),
  };
});

/**
 * Task H2 added four tasks, two of which are gated on Google credentials being
 * present. An empty environment therefore no longer produces "no tasks", and
 * these constants name the two environments explicitly so every assertion below
 * says which deployment it is describing.
 */
const NO_GOOGLE: Record<string, string | undefined> = {};

/** A deployment with the OAuth client and token key configured. */
const GOOGLE_ENV: Record<string, string | undefined> = {
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://app.test/callback",
  MAILBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
};

// ORDER IS THE CONTRACT, not a set: the scheduler runs due tasks in this order within a
// tick, and several tests below assert on positions. keyless-ingestion-enqueue sits
// immediately before ingestion-drain so work queued this tick is processed this tick;
// the drain then sits before the mailbox block deliberately — a drain that overruns its
// deadline delays whatever follows it, and mail classification is what the candidate
// actually notices.
const ALWAYS_ON = [
  FIT_RECONCILE_TASK_NAME,
  FIT_TASK_NAME,
  RANKING_REFRESH_TASK_NAME,
  ANTI_GHOSTING_TASK_NAME,
  KEYLESS_INGESTION_ENQUEUE_TASK_NAME,
  INGESTION_DRAIN_TASK_NAME,
  MAILBOX_CLASSIFY_TASK_NAME,
  MAILBOX_MATCH_TASK_NAME,
  INTAKE_REFRESH_DRAIN_TASK_NAME,
];

// The constants are imported for real rather than restubbed: the whole point of
// reading DEFAULT_MIN_AGE_DAYS here is to assert the scheduler uses the
// detector's own definition of "ghosted" instead of a literal that could drift.
vi.mock("./mailbox/antiGhosting.js", async (importActual) => {
  const actual = await importActual<typeof import("./mailbox/antiGhosting.js")>();
  return { ...actual, runFollowUpSweep: vi.fn() };
});

const client = {} as SupabaseClient;
const openai = {} as Pick<OpenAI, "chat">;

const fitResult = {
  claimed: 0,
  analyzed: 0,
  capped: 0,
  noJdText: 0,
  failed: 0,
};

const sweepResult = { detected: 0, drafted: 0, failed: 0, outcomes: [] };

function taskByName(name: string, env: Record<string, string | undefined> = {}) {
  const task = buildScheduledTasks(client, openai, env).find((entry) => entry.name === name);
  if (!task) {
    throw new Error("task not scheduled: " + name);
  }
  return task;
}

beforeEach(() => {
  vi.mocked(runFitAnalysisBatch).mockReset();
  vi.mocked(reconcileFitAnalyses).mockReset();
  vi.mocked(drainIntakeRefreshJobs).mockReset();
  vi.mocked(enqueueIngestionBatch).mockReset();
  vi.mocked(runFollowUpSweep).mockReset();
  vi.mocked(runScheduledRankingRefresh).mockReset();
  vi.mocked(runFitAnalysisBatch).mockResolvedValue({ ...fitResult });
  vi.mocked(reconcileFitAnalyses).mockResolvedValue({
    candidates: 0, vacancies: 0, scanned: 0, enqueued: 0, skipped: 0, truncated: false,
  });
  vi.mocked(runFollowUpSweep).mockResolvedValue({ ...sweepResult });
});

describe("cadence defaults", () => {
  it("drains fit analysis every five minutes", () => {
    expect(DEFAULT_FIT_INTERVAL_MS).toBe(300_000);
  });

  it("sweeps for ghosting once a day", () => {
    expect(DEFAULT_ANTI_GHOSTING_INTERVAL_MS).toBe(86_400_000);
  });

  it("pulls the keyless sources conservatively, four times a day", () => {
    expect(DEFAULT_KEYLESS_INGESTION_INTERVAL_MS).toBe(21_600_000);
  });
});

describe("parseDisabledTasks", () => {
  it("is empty when unset, so nothing is disabled by default", () => {
    expect(parseDisabledTasks(undefined).size).toBe(0);
    expect(parseDisabledTasks("").size).toBe(0);
  });

  it("splits, trims and lowercases a list", () => {
    expect([...parseDisabledTasks(" Fit-Analysis , anti-ghosting ")])
      .toEqual(["fit-analysis", "anti-ghosting"]);
  });
});

describe("buildScheduledTasks", () => {
  it("schedules both drains with their default intervals", () => {
    const tasks = buildScheduledTasks(client, openai, {});

    // Without Google credentials the Google-dependent tasks are absent, and the
    // two that need no Google access are still there.
    expect(tasks.map((task) => task.name)).toEqual(ALWAYS_ON);
    expect(tasks.map((task) => task.intervalMs).slice(0, 4)).toEqual([
      DEFAULT_FIT_RECONCILE_INTERVAL_MS,
      DEFAULT_FIT_INTERVAL_MS,
      DEFAULT_RANKING_REFRESH_INTERVAL_MS,
      DEFAULT_ANTI_GHOSTING_INTERVAL_MS,
    ]);
  });

  it("drains queued ingestion on its own cadence", () => {
    // The task that makes the 202 real. Without it, queue-and-return would only move the
    // work somewhere nothing ever collects it - the same shape as the old refresh route,
    // which drained a queue nothing filled.
    const task = taskByName(INGESTION_DRAIN_TASK_NAME, { SCHEDULER_INGESTION_DRAIN_INTERVAL_MS: "30000" });

    expect(task.intervalMs).toBe(30_000);
    expect(taskByName(INGESTION_DRAIN_TASK_NAME).intervalMs).toBe(DEFAULT_INGESTION_DRAIN_INTERVAL_MS);
  });

  it("enqueues the keyless pull BEFORE the drain, so one tick fetches and processes", () => {
    // The poll-before-classify pattern. An enqueue that ran after the drain would wait a
    // whole interval for its own work to be collected.
    const names = buildScheduledTasks(client, openai, {}).map((task) => task.name);

    expect(names.indexOf(KEYLESS_INGESTION_ENQUEUE_TASK_NAME)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(KEYLESS_INGESTION_ENQUEUE_TASK_NAME)).toBeLessThan(
      names.indexOf(INGESTION_DRAIN_TASK_NAME),
    );
  });

  it("no longer schedules a per-candidate discovery fetch", () => {
    // The global keyless pull refreshes the shared corpus once; fetching the same sources
    // again for every authorized candidate was the same requests repeated. The scheduler
    // must not quietly regain that work.
    const names = buildScheduledTasks(client, openai, {}).map((task) => task.name);

    expect(names).not.toContain("discovery");
    expect(names).toContain(KEYLESS_INGESTION_ENQUEUE_TASK_NAME);
  });

  it("retunes the keyless pull cadence without editing code", () => {
    const task = taskByName(KEYLESS_INGESTION_ENQUEUE_TASK_NAME, {
      SCHEDULER_KEYLESS_INGESTION_INTERVAL_MS: "300000",
    });

    expect(task.intervalMs).toBe(300_000);
    expect(taskByName(KEYLESS_INGESTION_ENQUEUE_TASK_NAME).intervalMs).toBe(
      DEFAULT_KEYLESS_INGESTION_INTERVAL_MS,
    );
  });

  it("drains candidate refresh requests and hands the fit batch the model client", async () => {
    // The task that makes the intake 202 real, and the carrier of the OpenAI client:
    // scoring the vacancies a refresh just created moved here with the fan-out.
    vi.mocked(drainIntakeRefreshJobs).mockResolvedValue({ processed: 2, stoppedOnDeadline: false });

    const task = taskByName(INTAKE_REFRESH_DRAIN_TASK_NAME, {});
    expect(task.intervalMs).toBe(DEFAULT_INTAKE_REFRESH_DRAIN_INTERVAL_MS);

    expect(await task.run()).toEqual({ processed: 2, stoppedOnDeadline: false });
    expect(vi.mocked(drainIntakeRefreshJobs)).toHaveBeenCalledWith(client, { deps: { openai } });
  });

  it("lets the refresh drain be bounded without editing code", async () => {
    vi.mocked(drainIntakeRefreshJobs).mockResolvedValue({ processed: 0, stoppedOnDeadline: false });

    await taskByName(INTAKE_REFRESH_DRAIN_TASK_NAME, {
      SCHEDULER_INTAKE_REFRESH_MAX_JOBS: "2",
      SCHEDULER_INTAKE_REFRESH_DEADLINE_MS: "90000",
    }).run();

    expect(vi.mocked(drainIntakeRefreshJobs)).toHaveBeenCalledWith(client, {
      deps: { openai },
      maxJobs: 2,
      deadlineMs: 90_000,
    });
  });

  it("lets each cadence be retuned without editing code", () => {
    const tasks = buildScheduledTasks(client, openai, {
      SCHEDULER_FIT_INTERVAL_MS: "60000",
      SCHEDULER_FIT_RECONCILE_INTERVAL_MS: "300000",
      SCHEDULER_RANKING_REFRESH_INTERVAL_MS: "90000",
      SCHEDULER_ANTI_GHOSTING_INTERVAL_MS: "43200000",
    });

    // BY NAME, not by position. Inserting a task shifts every index below it, and a
    // positional assertion then fails for a reason unrelated to what it is testing.
    const intervalOf = (name: string) => tasks.find((task) => task.name === name)?.intervalMs;

    expect(intervalOf(FIT_TASK_NAME)).toBe(60_000);
    expect(intervalOf(FIT_RECONCILE_TASK_NAME)).toBe(300_000);
    expect(intervalOf(RANKING_REFRESH_TASK_NAME)).toBe(90_000);
    expect(intervalOf(ANTI_GHOSTING_TASK_NAME)).toBe(43_200_000);
  });

  it("ignores an unparseable or negative interval rather than disabling the task", () => {
    // Named rather than positional: the reconcile task now sits ahead of this one.
    const tasks = buildScheduledTasks(client, openai, { SCHEDULER_FIT_INTERVAL_MS: "-5" });

    expect(tasks.find((task) => task.name === FIT_TASK_NAME)?.intervalMs).toBe(DEFAULT_FIT_INTERVAL_MS);
  });

  it("drops a disabled task and keeps the rest", () => {
    const tasks = buildScheduledTasks(client, openai, {
      SCHEDULER_DISABLED_TASKS: "anti-ghosting",
    });

    expect(tasks.map((task) => task.name)).toEqual(ALWAYS_ON.filter((name) => name !== ANTI_GHOSTING_TASK_NAME));
  });

  it("treats an unknown disabled name as inert", () => {
    const tasks = buildScheduledTasks(client, openai, { SCHEDULER_DISABLED_TASKS: "typo" });

    expect(tasks).toHaveLength(ALWAYS_ON.length);
  });

  describe("Google-dependent task gating (Task H2)", () => {
    it("registers mail polling and calendar sync when credentials are present", () => {
      const names = buildScheduledTasks(client, openai, GOOGLE_ENV).map((task) => task.name);

      expect(names).toContain(MAILBOX_POLL_TASK_NAME);
      expect(names).toContain(CALENDAR_SYNC_TASK_NAME);
      expect(names).toHaveLength(ALWAYS_ON.length + 2);
    });

    it("omits them without credentials rather than failing to start", () => {
      const names = buildScheduledTasks(client, openai, NO_GOOGLE).map((task) => task.name);

      expect(names).not.toContain(MAILBOX_POLL_TASK_NAME);
      expect(names).not.toContain(CALENDAR_SYNC_TASK_NAME);
    });

    it("keeps classification and matching, which need no Google access", () => {
      const names = buildScheduledTasks(client, openai, NO_GOOGLE).map((task) => task.name);

      expect(names).toContain(MAILBOX_CLASSIFY_TASK_NAME);
      expect(names).toContain(MAILBOX_MATCH_TASK_NAME);
    });

    it("runs the mail chain poll -> classify -> match, so one tick does all three", () => {
      const names = buildScheduledTasks(client, openai, GOOGLE_ENV).map((task) => task.name);

      expect(names.indexOf(MAILBOX_POLL_TASK_NAME)).toBeLessThan(names.indexOf(MAILBOX_CLASSIFY_TASK_NAME));
      expect(names.indexOf(MAILBOX_CLASSIFY_TASK_NAME)).toBeLessThan(names.indexOf(MAILBOX_MATCH_TASK_NAME));
    });
  });

  describe("the mailbox and calendar tasks", () => {
    it("retunes each cadence independently", () => {
      const tasks = buildScheduledTasks(client, openai, {
        ...GOOGLE_ENV,
        SCHEDULER_MAILBOX_POLL_INTERVAL_MS: "60000",
        SCHEDULER_CALENDAR_SYNC_INTERVAL_MS: "120000",
      });

      expect(tasks.find((task) => task.name === MAILBOX_POLL_TASK_NAME)?.intervalMs).toBe(60_000);
      expect(tasks.find((task) => task.name === CALENDAR_SYNC_TASK_NAME)?.intervalMs).toBe(120_000);
    });

    it("can disable just the Google tasks without touching the rest", () => {
      const names = buildScheduledTasks(client, openai, {
        ...GOOGLE_ENV,
        SCHEDULER_DISABLED_TASKS: "mailbox-poll,calendar-sync",
      }).map((task) => task.name);

      expect(names).toEqual(ALWAYS_ON);
    });

    it("reports the poll result rather than the raw object", async () => {
      const { runMailboxPollingBatch } = await import("./mailbox/poll.js");
      vi.mocked(runMailboxPollingBatch).mockResolvedValue({
        claimed: 2,
        succeeded: 1,
        transientErrors: 1,
        terminalErrors: 0,
      });

      const summary = await taskByName(MAILBOX_POLL_TASK_NAME, GOOGLE_ENV).run();

      expect(summary).toEqual({ claimed: 2, succeeded: 1, transientErrors: 1, terminalErrors: 0 });
    });

    it("reports the calendar result including how many events were unlinked", async () => {
      const { runCalendarSyncBatch } = await import("./calendar/sync.js");
      vi.mocked(runCalendarSyncBatch).mockResolvedValue({
        connections: 1,
        created: 2,
        rescheduled: 1,
        updated: 0,
        cancelled: 1,
        skippedUnlinked: 7,
        failures: 0,
      });

      const summary = await taskByName(CALENDAR_SYNC_TASK_NAME, GOOGLE_ENV).run();

      expect(summary).toEqual({
        connections: 1,
        created: 2,
        rescheduled: 1,
        updated: 0,
        cancelled: 1,
        skippedUnlinked: 7,
        failures: 0,
      });
    });
  });
});

/**
 * Step 6 — the SCHEDULED keyless pull.
 *
 * The scheduler ONLY ENQUEUES. Processing stays with ingestion-drain, so a single
 * 392-second board cannot overrun the task that decides what to fetch, and there is
 * exactly one claimant for the queue.
 */
describe("the keyless scheduled pull", () => {
  const emptyEnqueue = { targets: [], enqueued: 0, skippedRecent: 0, skippedQueued: 0 };

  it("enqueues only the named keyless sources, and drains none of them itself", async () => {
    vi.mocked(enqueueIngestionBatch).mockResolvedValue({ ...emptyEnqueue, enqueued: 2 });

    const summary = await taskByName(KEYLESS_INGESTION_ENQUEUE_TASK_NAME, {}).run();

    expect(summary).toEqual({ ...emptyEnqueue, enqueued: 2 });
    expect(vi.mocked(enqueueIngestionBatch)).toHaveBeenCalledWith(client, {
      sourceCodes: KEYLESS_SCHEDULED_SOURCE_CODES,
    });
  });

  it("never names a quota-bearing source, so Jooble cannot be queued unattended", async () => {
    // The unattended path is the one nobody is watching: a source accidentally included
    // here would spend its allowance every tick, indefinitely.
    vi.mocked(enqueueIngestionBatch).mockResolvedValue({ ...emptyEnqueue });

    await taskByName(KEYLESS_INGESTION_ENQUEUE_TASK_NAME, {}).run();

    const options = vi.mocked(enqueueIngestionBatch).mock.calls[0]![1];
    expect(options?.sourceCodes).toEqual(KEYLESS_SCHEDULED_SOURCE_CODES);
    expect(options?.sourceCodes).not.toContain("jooble");
    expect(options?.sourceCodes).not.toContain("adzuna");
    expect(options?.sourceCodes).not.toContain("serpapi");
  });

  it("never drains, so the shared ingestion drain is the only claimant", async () => {
    vi.mocked(enqueueIngestionBatch).mockResolvedValue({ ...emptyEnqueue });

    await taskByName(KEYLESS_INGESTION_ENQUEUE_TASK_NAME, {}).run();

    expect(vi.mocked(drainIngestionJobs)).not.toHaveBeenCalled();
  });
});

describe("the fit-analysis task", () => {
  it("drains the queue and reports what moved", async () => {
    vi.mocked(runFitAnalysisBatch).mockResolvedValue({
      claimed: 5,
      analyzed: 4,
      capped: 1,
      noJdText: 2,
      failed: 0,
    });

    const summary = await taskByName(FIT_TASK_NAME, {}).run();

    expect(summary).toEqual({ claimed: 5, analyzed: 4, failed: 0, capped: 1, noJdText: 2 });
  });

  it("passes the documented batch limit through", async () => {
    await taskByName(FIT_TASK_NAME, { FIT_ANALYSIS_BATCH_LIMIT: "7" }).run();

    expect(vi.mocked(runFitAnalysisBatch)).toHaveBeenCalledWith(
      client,
      { openai },
      { maxPerBatch: 7 },
    );
  });

  it("omits the batch limit when it is not configured, leaving the runner's default", async () => {
    await taskByName(FIT_TASK_NAME, {}).run();

    expect(vi.mocked(runFitAnalysisBatch)).toHaveBeenCalledWith(
      client,
      { openai },
      { maxPerBatch: undefined },
    );
  });

  it("surfaces an infra-level claim error instead of hiding it in the numbers", async () => {
    vi.mocked(runFitAnalysisBatch).mockResolvedValue({
      ...fitResult,
      claimError: "connection reset",
    });

    expect(await taskByName(FIT_TASK_NAME, {}).run()).toMatchObject({ claimError: "connection reset" });
  });

  it("surfaces a deadline stop", async () => {
    vi.mocked(runFitAnalysisBatch).mockResolvedValue({ ...fitResult, stoppedOnDeadline: true });

    expect(await taskByName(FIT_TASK_NAME, {}).run()).toMatchObject({ stoppedOnDeadline: true });
  });
});

describe("the fit-reconcile task", () => {
  it("is scheduled, on a slower cadence than the drain", () => {
    // THE CAP LEFT A TAIL. Since 20261016090000 the triggers queue only the newest 200
    // eligible vacancies per candidate action, so the remainder has to come from somewhere
    // or those vacancies never get a score. reconcileFitAnalyses is enqueue-only and
    // DB-only, so it is cheap enough to run on a schedule and cannot itself spend tokens.
    expect(DEFAULT_FIT_RECONCILE_INTERVAL_MS).toBeGreaterThanOrEqual(DEFAULT_FIT_INTERVAL_MS);
    expect(taskByName(FIT_RECONCILE_TASK_NAME, {}).intervalMs).toBe(DEFAULT_FIT_RECONCILE_INTERVAL_MS);
    expect(
      taskByName(FIT_RECONCILE_TASK_NAME, { SCHEDULER_FIT_RECONCILE_INTERVAL_MS: "60000" }).intervalMs,
    ).toBe(60_000);
  });

  it("runs BEFORE the fit drain, so a tick collects what it just queued", () => {
    // The poll-before-classify ordering used everywhere else in this array. A reconcile
    // placed after the drain would wait a whole interval for its own work to be collected.
    const names = buildScheduledTasks(client, openai, {}).map((task) => task.name);

    expect(names.indexOf(FIT_RECONCILE_TASK_NAME)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(FIT_RECONCILE_TASK_NAME)).toBeLessThan(names.indexOf(FIT_TASK_NAME));
  });

  it("passes the documented limit through, and leaves it unset by default", async () => {
    await taskByName(FIT_RECONCILE_TASK_NAME, { FIT_RECONCILE_LIMIT: "7" }).run();

    expect(vi.mocked(reconcileFitAnalyses)).toHaveBeenCalledWith(client, { limit: 7 });

    await taskByName(FIT_RECONCILE_TASK_NAME, {}).run();

    expect(vi.mocked(reconcileFitAnalyses)).toHaveBeenCalledWith(client, { limit: undefined });
  });

  it("reports the enqueue counts and whether the pass was truncated", async () => {
    // truncated is the operator's signal that the tail is not yet filled and the pass
    // needs to run again, so it must survive into the scheduler's log.
    vi.mocked(reconcileFitAnalyses).mockResolvedValue({
      candidates: 2, vacancies: 743, scanned: 1486, enqueued: 500, skipped: 986, truncated: true,
    });

    expect(await taskByName(FIT_RECONCILE_TASK_NAME, {}).run()).toEqual({
      candidates: 2, vacancies: 743, scanned: 1486, enqueued: 500, skipped: 986, truncated: true,
    });
  });
});

describe("the anti-ghosting task", () => {
  it("uses the detector's own window and cap by default", async () => {
    await taskByName(ANTI_GHOSTING_TASK_NAME, {}).run();

    expect(vi.mocked(runFollowUpSweep)).toHaveBeenCalledWith(
      client,
      { openai },
      { minAgeDays: 7, limit: 20 },
    );
  });

  it("reports how many were detected, drafted and failed", async () => {
    vi.mocked(runFollowUpSweep).mockResolvedValue({
      detected: 3,
      drafted: 2,
      failed: 1,
      outcomes: [],
    });

    expect(await taskByName(ANTI_GHOSTING_TASK_NAME, {}).run())
      .toEqual({ detected: 3, drafted: 2, failed: 1 });
  });

  it("carries each refused draft's own reason into the log, not just a count", async () => {
    // The sweep deliberately does not throw for one bad draft, so without this
    // the operator would see "failed: 1" and have nothing to act on. The
    // generator's message names the exact claim the honesty gate rejected.
    vi.mocked(runFollowUpSweep).mockResolvedValue({
      detected: 2,
      drafted: 1,
      failed: 1,
      outcomes: [
        {
          applicationAttemptId: "attempt-ok",
          daysSinceSubmission: 9,
          outcome: "drafted",
          draftId: "draft-1",
        },
        {
          applicationAttemptId: "attempt-refused",
          daysSinceSubmission: 11,
          outcome: "failed",
          error: "UncitedClaimError: no cited confirmed fact",
        },
      ],
    });

    const summary = await taskByName(ANTI_GHOSTING_TASK_NAME, {}).run();

    expect(summary).toEqual({
      detected: 2,
      drafted: 1,
      failed: 1,
      failures: [
        { applicationAttemptId: "attempt-refused", error: "UncitedClaimError: no cited confirmed fact" },
      ],
    });
  });

  it("omits the failures key entirely on a clean sweep", async () => {
    vi.mocked(runFollowUpSweep).mockResolvedValue({ detected: 0, drafted: 0, failed: 0, outcomes: [] });

    expect(await taskByName(ANTI_GHOSTING_TASK_NAME, {}).run()).not.toHaveProperty("failures");
  });

  it("lets the window and cap be retuned", async () => {
    await taskByName(ANTI_GHOSTING_TASK_NAME, {
      FOLLOW_UP_MIN_AGE_DAYS: "3",
      FOLLOW_UP_SWEEP_LIMIT: "5",
    }).run();

    expect(vi.mocked(runFollowUpSweep)).toHaveBeenCalledWith(
      client,
      { openai },
      { minAgeDays: 3, limit: 5 },
    );
  });

  it("propagates a detection-query failure so the loop can back off", async () => {
    vi.mocked(runFollowUpSweep).mockRejectedValue(new Error("rpc unavailable"));

    await expect(taskByName(ANTI_GHOSTING_TASK_NAME, {}).run()).rejects.toThrow("rpc unavailable");
  });
});

describe("the Batch C scheduled refresh tasks", () => {
  it("schedules the ranking refresh at its own default cadence and logs the tick summary", async () => {
    vi.mocked(runScheduledRankingRefresh).mockResolvedValue({
      candidatesConsidered: 2,
      completed: 1,
      failed: 1,
      stillRunning: 0,
      noTargetRoles: 0,
      deadlineReached: false,
      identities: ["identity-1"],
    });

    const task = taskByName(RANKING_REFRESH_TASK_NAME, {});
    expect(task.intervalMs).toBe(DEFAULT_RANKING_REFRESH_INTERVAL_MS);

    const summary = await task.run();
    expect(summary).toMatchObject({ candidatesConsidered: 2, completed: 1, failed: 1 });
    // The budget comes from the environment, with the documented defaults.
    expect(vi.mocked(runScheduledRankingRefresh)).toHaveBeenCalledWith(client, {
      budget: expect.objectContaining({ maxCandidates: 20, perCandidateDeadlineMs: 10_000 }),
    });
  });

  it("retunes the ranking cadence without editing code", () => {
    const tasks = buildScheduledTasks(client, openai, {
      SCHEDULER_RANKING_REFRESH_INTERVAL_MS: "45000",
    });

    expect(tasks.find((task) => task.name === RANKING_REFRESH_TASK_NAME)?.intervalMs).toBe(45_000);
  });


});
