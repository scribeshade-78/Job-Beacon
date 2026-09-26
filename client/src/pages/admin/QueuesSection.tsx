import { useEffect, useState } from "react";
import {
  getAdminQueues,
  retryAdminQueueJob,
  runAdminWorkerTask,
  ADMIN_QUEUE_LABELS,
  ADMIN_WORKER_TASKS,
  ADMIN_WORKER_TASK_LABELS,
  type AdminDeadLetterJob,
  type AdminQueueName,
  type AdminQueuesOverview,
  type AdminWorkerTaskName,
} from "../../lib/admin";
import { AdminCard, RefreshButton, SectionMessage, getAccessToken } from "./shared";

/**
 * Queues and Workers — the last static mock in the console, replaced by real
 * data.
 *
 * WHAT THIS ANSWERS. Three Postgres lease queues back the background work
 * (ingestion_jobs, fit_analysis_jobs, company_registry_lookup_jobs), and before
 * this screen the only way to see any of them was to open a SQL client. Depth
 * by status, how long the oldest pending row has waited, and the ten most
 * recent dead letters per queue are now one page — with a manual re-arm for a
 * job that exhausted its attempts.
 *
 * THE TRIGGERS ARE NOT THE /api/worker/* ROUTES. Those are authenticated by
 * WORKER_TRIGGER_SECRET, which a browser must not hold: it would hand every
 * admin session the credential an external cron uses. These call the same
 * functions behind requireAuth + requireAdmin instead, so no shared secret
 * reaches the client.
 *
 * APPLICATIONS IS DELIBERATELY ABSENT, and the note under the buttons says so.
 * runApplicationBatch dispatches real submissions for candidates who did not ask
 * to review first; that is not a good fit for one button among eight in an ops
 * console. The server refuses the name outright, so this is a UI echo of a real
 * boundary rather than a missing control.
 *
 * RE-ARMING DOES NOT RUN ANYTHING. It only puts a failed row back in the queue;
 * draining it is a separate, explicit click, so an operator chooses when to
 * spend the fetch. That also means a re-armed ingestion job sits pending until
 * the ingestion trigger (or a candidate refresh) drains it — and the UI says so
 * rather than implying the retry itself fixed anything.
 */

const STATUS_COLUMNS = ["pending", "leased", "done", "failed"] as const;

function formatAge(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m";

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";

  return Math.floor(hours / 24) + "d";
}

function describeResult(result: Record<string, unknown>): string {
  const parts = Object.entries(result).map(([key, value]) => key + " " + String(value));
  return parts.length === 0 ? "no counters returned" : parts.join(", ");
}

export function QueuesSection() {
  const [overview, setOverview] = useState<AdminQueuesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);

      const accessToken = await getAccessToken();
      if (!accessToken) {
        if (!cancelled) {
          setError("Your session has expired.");
          setLoading(false);
        }
        return;
      }

      const result = await getAdminQueues(accessToken);
      if (cancelled) return;

      if (result.kind === "success") {
        setOverview(result.data);
        setError(null);
      } else if (result.kind === "forbidden") {
        setError("You don't have admin access.");
      } else {
        setError(result.message);
      }

      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  async function retry(queue: AdminQueueName, job: AdminDeadLetterJob) {
    setBusyKey("retry:" + job.id);
    setError(null);
    setNotice(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusyKey(null);
      return;
    }

    const result = await retryAdminQueueJob(queue, job.id, accessToken);

    if (result.kind === "success") {
      setNotice(
        "Re-armed " + job.label + " in " + ADMIN_QUEUE_LABELS[queue] + ". It is pending again, not run — use a worker trigger to drain it.",
      );
      setReloadToken((current) => current + 1);
    } else if (result.kind === "forbidden") {
      setError("You don't have admin access.");
    } else {
      setError(result.message);
    }

    setBusyKey(null);
  }

  async function trigger(task: AdminWorkerTaskName) {
    setBusyKey("task:" + task);
    setTaskError(null);
    setNotice(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setTaskError("Your session has expired.");
      setBusyKey(null);
      return;
    }

    const result = await runAdminWorkerTask(task, accessToken);

    if (result.kind === "success") {
      setNotice(ADMIN_WORKER_TASK_LABELS[task] + " finished — " + describeResult(result.data.result));
      setReloadToken((current) => current + 1);
    } else if (result.kind === "forbidden") {
      setTaskError("You don't have admin access.");
    } else {
      setTaskError(result.message);
    }

    setBusyKey(null);
  }

  return (
    <div className="space-y-4">
      <AdminCard
        title="Queue depth"
        description="The three Postgres lease queues. Counts are per status; the age is how long the oldest pending job has been waiting."
        action={<RefreshButton onClick={() => setReloadToken((current) => current + 1)} busy={loading} />}
      >
        {error && <SectionMessage tone="error">{error}</SectionMessage>}

        {overview === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Queue</th>
                  {STATUS_COLUMNS.map((status) => (
                    <th key={status} className="py-2 pr-4 font-medium">
                      {status}
                    </th>
                  ))}
                  <th className="py-2 pr-4 font-medium">Oldest pending</th>
                </tr>
              </thead>
              <tbody>
                {overview.queues.map((entry) => (
                  <tr key={entry.queue} className="border-b border-slate-900">
                    <td className="py-2 pr-4 text-xs text-slate-300">{ADMIN_QUEUE_LABELS[entry.queue]}</td>
                    {STATUS_COLUMNS.map((status) => (
                      <td
                        key={status}
                        className={
                          "py-2 pr-4 font-mono text-xs " +
                          (status === "failed" && entry.counts.failed > 0 ? "text-rose-400" : "text-slate-400")
                        }
                      >
                        {entry.counts[status]}
                      </td>
                    ))}
                    <td className="py-2 pr-4 text-xs text-slate-400">
                      {entry.oldestPendingAt ? (
                        <span title={entry.oldestPendingAt}>{formatAge(entry.oldestPendingAt)}</span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminCard
        title="Worker triggers"
        description="Run one bounded batch now. Bounds are decided server-side — the client cannot widen them — and every trigger is audited against your account."
      >
        {notice && (
          <p className="mb-3 text-sm text-emerald-300" role="status">
            {notice}
          </p>
        )}
        {taskError && <SectionMessage tone="error">{taskError}</SectionMessage>}

        <div className="flex flex-wrap gap-2">
          {ADMIN_WORKER_TASKS.map((task) => (
            <button
              key={task}
              type="button"
              disabled={busyKey !== null}
              onClick={() => void trigger(task)}
              className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40"
            >
              {busyKey === "task:" + task ? "Running…" : ADMIN_WORKER_TASK_LABELS[task]}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Two of these spend money or someone else's quota per run: the ingestion fetch draws on the source APIs (Jooble
          is a 500-request lifetime budget) and fit analysis and classification call the model. Triggers are limited to
          10 per 15 minutes per admin.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Application submission is deliberately not offered here. The server refuses it: it dispatches real
          applications for candidates who did not ask to review first, which is not a one-click ops action.
        </p>
        <p className="mt-2 text-xs text-slate-500">
          Mailbox poll and calendar sync return a configuration error when Google credentials are absent, naming the
          missing environment variable rather than failing silently.
        </p>
      </AdminCard>

      <AdminCard
        title="Dead-letter jobs"
        description="Jobs that exhausted their attempts. Re-arming returns the row to pending; it does not run it, so draining stays an explicit choice."
      >
        {overview === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : overview.queues.every((entry) => entry.deadLetters.length === 0) ? (
          <SectionMessage tone="muted">
            No dead-lettered jobs in any queue. Nothing has exhausted its attempts.
          </SectionMessage>
        ) : (
          <div className="space-y-4">
            {overview.queues
              .filter((entry) => entry.deadLetters.length > 0)
              .map((entry) => (
                <div key={entry.queue}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {ADMIN_QUEUE_LABELS[entry.queue]} ({entry.deadLetters.length})
                  </h3>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse text-left">
                      <thead>
                        <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                          <th className="py-2 pr-4 font-medium">Job</th>
                          <th className="py-2 pr-4 font-medium">Attempts</th>
                          <th className="py-2 pr-4 font-medium">Last error</th>
                          <th className="py-2 pr-4 font-medium">Failed</th>
                          <th className="py-2 pr-4 font-medium" aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {entry.deadLetters.map((job) => (
                          <tr key={job.id} className="border-b border-slate-900 align-top">
                            <td className="py-2 pr-4 text-xs text-slate-300">
                              <span title={job.id}>{job.label}</span>
                            </td>
                            <td className="py-2 pr-4 font-mono text-xs text-slate-400">
                              {job.attempts} / {job.maxAttempts}
                            </td>
                            <td className="max-w-[380px] py-2 pr-4 text-xs text-slate-400">
                              {job.lastError ? (
                                <span className="break-words" title={job.lastError}>
                                  {job.lastError}
                                </span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-4 text-xs text-slate-500">
                              {job.updatedAt ? (
                                <span title={job.updatedAt}>{formatAge(job.updatedAt)} ago</span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              <button
                                type="button"
                                disabled={busyKey !== null}
                                onClick={() => void retry(entry.queue, job)}
                                className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40"
                              >
                                {busyKey === "retry:" + job.id ? "Re-arming…" : "Re-arm"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

            <p className="text-xs text-slate-500">
              Showing at most {overview.deadLetterLimit} failed jobs per queue, newest first.
            </p>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
