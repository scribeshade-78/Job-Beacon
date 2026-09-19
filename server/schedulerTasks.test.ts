import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFitAnalysisBatch } from "./opportunities/runner.js";
import { runFollowUpSweep } from "./mailbox/antiGhosting.js";
import {
  ANTI_GHOSTING_TASK_NAME,
  buildScheduledTasks,
  CALENDAR_SYNC_TASK_NAME,
  DEFAULT_ANTI_GHOSTING_INTERVAL_MS,
  DEFAULT_FIT_INTERVAL_MS,
  FIT_TASK_NAME,
  MAILBOX_CLASSIFY_TASK_NAME,
  MAILBOX_MATCH_TASK_NAME,
  MAILBOX_POLL_TASK_NAME,
  parseDisabledTasks,
} from "./schedulerTasks.js";

vi.mock("./opportunities/runner.js", () => ({ runFitAnalysisBatch: vi.fn() }));
vi.mock("./mailbox/poll.js", () => ({ runMailboxPollingBatch: vi.fn() }));
vi.mock("./mailbox/classifyBatch.js", () => ({ runMessageClassificationBatch: vi.fn() }));
vi.mock("./mailbox/matchBatch.js", () => ({ runApplicationMatchBatch: vi.fn() }));
vi.mock("./calendar/sync.js", () => ({ runCalendarSyncBatch: vi.fn() }));

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

const ALWAYS_ON = [FIT_TASK_NAME, ANTI_GHOSTING_TASK_NAME, MAILBOX_CLASSIFY_TASK_NAME, MAILBOX_MATCH_TASK_NAME];

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
  vi.mocked(runFollowUpSweep).mockReset();
  vi.mocked(runFitAnalysisBatch).mockResolvedValue({ ...fitResult });
  vi.mocked(runFollowUpSweep).mockResolvedValue({ ...sweepResult });
});

describe("cadence defaults", () => {
  it("drains fit analysis every five minutes", () => {
    expect(DEFAULT_FIT_INTERVAL_MS).toBe(300_000);
  });

  it("sweeps for ghosting once a day", () => {
    expect(DEFAULT_ANTI_GHOSTING_INTERVAL_MS).toBe(86_400_000);
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
    expect(tasks.map((task) => task.intervalMs).slice(0, 2))
      .toEqual([DEFAULT_FIT_INTERVAL_MS, DEFAULT_ANTI_GHOSTING_INTERVAL_MS]);
  });

  it("lets each cadence be retuned without editing code", () => {
    const tasks = buildScheduledTasks(client, openai, {
      SCHEDULER_FIT_INTERVAL_MS: "60000",
      SCHEDULER_ANTI_GHOSTING_INTERVAL_MS: "43200000",
    });

    expect(tasks.map((task) => task.intervalMs).slice(0, 2)).toEqual([60_000, 43_200_000]);
  });

  it("ignores an unparseable or negative interval rather than disabling the task", () => {
    const tasks = buildScheduledTasks(client, openai, { SCHEDULER_FIT_INTERVAL_MS: "-5" });

    expect(tasks[0]?.intervalMs).toBe(DEFAULT_FIT_INTERVAL_MS);
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
