import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ingestion/runner.js", () => ({ runIngestionBatch: vi.fn() }));
vi.mock("../opportunities/runner.js", () => ({ runFitAnalysisBatch: vi.fn() }));
vi.mock("../mailbox/classifyBatch.js", () => ({ runMessageClassificationBatch: vi.fn() }));
vi.mock("../mailbox/matchBatch.js", () => ({ runApplicationMatchBatch: vi.fn() }));
vi.mock("../mailbox/poll.js", () => ({ runMailboxPollingBatch: vi.fn() }));
vi.mock("../mailbox/antiGhosting.js", () => ({ runFollowUpSweep: vi.fn() }));
vi.mock("../calendar/sync.js", () => ({ runCalendarSyncBatch: vi.fn() }));

import { runIngestionBatch } from "../ingestion/runner.js";
import { runFitAnalysisBatch } from "../opportunities/runner.js";
import { runMessageClassificationBatch } from "../mailbox/classifyBatch.js";
import { runApplicationMatchBatch } from "../mailbox/matchBatch.js";
import { runMailboxPollingBatch } from "../mailbox/poll.js";
import { runFollowUpSweep } from "../mailbox/antiGhosting.js";
import { runCalendarSyncBatch } from "../calendar/sync.js";
import {
  ADMIN_WORKER_TASKS,
  isAdminWorkerTask,
  runAdminWorkerTask,
  WorkerTaskNotConfiguredError,
  type AdminWorkerTaskDeps,
} from "./workerTasks.js";

const client = {} as never;
const openaiClient = { chat: {} } as never;
const googleConfig = { clientId: "id" } as never;
const encryptionKey = { length: 32 } as never;

function makeDeps(overrides: Partial<AdminWorkerTaskDeps> = {}): AdminWorkerTaskDeps {
  return {
    openai: () => openaiClient,
    googleOAuthConfig: () => googleConfig,
    mailboxEncryptionKey: () => encryptionKey,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isAdminWorkerTask", () => {
  it("accepts all seven triggerable tasks", () => {
    for (const task of ADMIN_WORKER_TASKS) {
      expect(isAdminWorkerTask(task)).toBe(true);
    }
    expect(ADMIN_WORKER_TASKS).toHaveLength(7);
  });

  it("refuses the two deliberately excluded names", () => {
    // applications dispatches real submissions; registry-lookup has no
    // credentials anywhere in the repository. Both must stay untriggerable.
    expect(isAdminWorkerTask("applications")).toBe(false);
    expect(isAdminWorkerTask("registry-lookup")).toBe(false);
  });

  it("rejects anything else", () => {
    for (const value of ["Applications", "", null, undefined, 7, {}]) {
      expect(isAdminWorkerTask(value)).toBe(false);
    }
  });
});

describe("runAdminWorkerTask", () => {
  it("match-messages runs the linking batch with no model call", async () => {
    vi.mocked(runApplicationMatchBatch).mockResolvedValue({
      scanned: 3,
      linked: 2,
      review: 1,
      ambiguous: 0,
      unmatched: 0,
      errors: 0,
    } as never);

    const result = await runAdminWorkerTask(client, "match-messages", makeDeps());

    expect(runApplicationMatchBatch).toHaveBeenCalledWith(client);
    expect(result).toEqual({ scanned: 3, linked: 2, review: 1, ambiguous: 0, unmatched: 0, errors: 0 });
  });

  it("classify-messages passes the resolved model client", async () => {
    vi.mocked(runMessageClassificationBatch).mockResolvedValue({
      scanned: 2,
      classified: 2,
      malformed: 0,
      errors: 0,
    } as never);

    await runAdminWorkerTask(client, "classify-messages", makeDeps());

    expect(runMessageClassificationBatch).toHaveBeenCalledWith(client, openaiClient);
  });

  it("fit-analysis passes the model under the deps key the runner expects", async () => {
    vi.mocked(runFitAnalysisBatch).mockResolvedValue({
      claimed: 1,
      analyzed: 1,
      capped: 0,
      noJdText: 0,
      failed: 0,
    } as never);

    await runAdminWorkerTask(client, "fit-analysis", makeDeps());

    expect(runFitAnalysisBatch).toHaveBeenCalledWith(client, { openai: openaiClient });
  });

  it("ingestion reports the target count rather than the whole target array", async () => {
    vi.mocked(runIngestionBatch).mockResolvedValue({
      targets: [{}, {}, {}],
      vacanciesFetched: 5,
      failed: 1,
      skippedRecent: 0,
      skippedQueued: 2,
    } as never);

    const result = await runAdminWorkerTask(client, "ingestion", makeDeps());

    expect(runIngestionBatch).toHaveBeenCalledWith(client);
    expect(result).toEqual({ targets: 3, vacanciesFetched: 5, failed: 1, skippedRecent: 0, skippedQueued: 2 });
  });

  it("anti-ghosting passes the model client", async () => {
    vi.mocked(runFollowUpSweep).mockResolvedValue({ detected: 4, drafted: 4, failed: 0 } as never);

    await runAdminWorkerTask(client, "anti-ghosting", makeDeps());

    expect(runFollowUpSweep).toHaveBeenCalledWith(client, { openai: openaiClient });
  });

  it("mailbox-poll resolves every Google dependency it needs", async () => {
    vi.mocked(runMailboxPollingBatch).mockResolvedValue({
      claimed: 1,
      succeeded: 1,
      transientErrors: 0,
      terminalErrors: 0,
    } as never);

    await runAdminWorkerTask(client, "mailbox-poll", makeDeps());

    expect(runMailboxPollingBatch).toHaveBeenCalledWith(client, googleConfig, encryptionKey, fetch, openaiClient);
  });

  it("calendar-sync resolves the Google dependencies", async () => {
    vi.mocked(runCalendarSyncBatch).mockResolvedValue({
      connections: 1,
      created: 0,
      rescheduled: 0,
      updated: 0,
      cancelled: 0,
      skippedUnlinked: 1,
      failures: 0,
    } as never);

    await runAdminWorkerTask(client, "calendar-sync", makeDeps());

    expect(runCalendarSyncBatch).toHaveBeenCalledWith(client, googleConfig, encryptionKey, fetch);
  });

  it("turns a missing Google credential into a named not-configured error", async () => {
    const deps = makeDeps({
      googleOAuthConfig: () => {
        throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID.");
      },
    });

    await expect(runAdminWorkerTask(client, "mailbox-poll", deps)).rejects.toBeInstanceOf(
      WorkerTaskNotConfiguredError,
    );
    await expect(runAdminWorkerTask(client, "mailbox-poll", deps)).rejects.toThrow(/mailbox-poll/);
  });

  it("turns a missing model credential into a named not-configured error", async () => {
    const deps = makeDeps({
      openai: () => {
        throw new Error("Missing OPENROUTER_API_KEY.");
      },
    });

    await expect(runAdminWorkerTask(client, "fit-analysis", deps)).rejects.toThrow(WorkerTaskNotConfiguredError);
  });

  it("does not resolve Google credentials for a task that needs none", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      googleOAuthConfig: () => {
        seen.push("google");
        throw new Error("must not be read");
      },
    });
    vi.mocked(runApplicationMatchBatch).mockResolvedValue({
      scanned: 0,
      linked: 0,
      review: 0,
      ambiguous: 0,
      unmatched: 0,
      errors: 0,
    } as never);

    await runAdminWorkerTask(client, "match-messages", deps);

    expect(seen).toEqual([]);
  });

  it("throws loudly for a task name outside the union", async () => {
    await expect(runAdminWorkerTask(client, "applications" as never, makeDeps())).rejects.toThrow(
      /Unhandled worker task/,
    );
  });
});
