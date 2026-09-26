import { useEffect, useState, type ReactNode } from "react";
import {
  getModerationQueue,
  submitModerationDecision,
  MODERATION_DECISIONS,
  type ModerationDecisionValue,
  type ModerationQueueEntry,
} from "../../lib/moderation";
import {
  getEmployerClaimsQueue,
  submitEmployerClaimDecision,
  EMPLOYER_CLAIM_DECISIONS,
  type EmployerClaimDecisionValue,
  type EmployerClaimQueueEntry,
} from "../../lib/employer";
import {
  getCompanyFactCorrectionsQueue,
  submitCorrectionDecision,
  CORRECTABLE_FIELD_LABELS,
  CORRECTION_DECISIONS,
  type CorrectionDecisionValue,
  type CompanyFactCorrectionQueueEntry,
} from "../../lib/companyFactCorrections";
import { getAppealsQueue, type AppealQueueEntry } from "../../lib/employerAppeals";
import { safeVacancyHref } from "../../panels/shared";
import { AdminCard, RefreshButton, SectionMessage, getAccessToken } from "./shared";

/**
 * R8.1/R8.2 — every moderation queue an admin can action, in the console's own
 * dark palette.
 *
 * THE WHOLE FAMILY LIVES HERE, and that is a deliberate choice rather than
 * duplication for its own sake. The four queues are the same task — read a
 * pending item, record a rationale, decide — and an admin should not have to
 * leave the console and land on a differently-themed page to finish one. The
 * panels on /moderator remain the moderator console; these are slate
 * equivalents because the moderator panels are built on the ios-* tokens, whose
 * text-black would be unreadable on this console's slate background (see
 * shared.tsx).
 *
 * ADMINS REACH ALL FOUR. Every route behind these cards is gated
 * requireModeratorOrAdmin server-side, so nothing here is a privilege
 * escalation — it is the existing moderator surface, rendered where an admin
 * already is. Each card owns its own fetch, refresh and error state: one queue
 * being unavailable must not blank the other three.
 */

const FORBIDDEN_MESSAGE = "You don't have moderator or admin access.";

const FIELD_CLASS =
  "w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600";

const BUTTON_CLASS =
  "rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-40";

const PANE_CLASS = "rounded-md border border-slate-800 bg-slate-950/40 p-4";

const DECISION_LABEL: Record<ModerationDecisionValue, string> = {
  cleared: "Clear",
  flagged: "Flag",
  blocked: "Block",
  request_info: "Request info",
  escalated: "Escalate",
};

/** Appeal decisions move the original decision, so the wording says which way. */
const APPEAL_DECISION_LABEL: Record<ModerationDecisionValue, string> = {
  cleared: "Overturn (clear)",
  flagged: "Uphold (flag)",
  blocked: "Uphold (block)",
  request_info: "Request info",
  escalated: "Escalate",
};

const CLAIM_DECISION_LABEL: Record<EmployerClaimDecisionValue, string> = {
  verified: "Verify",
  rejected: "Reject",
};

const CORRECTION_DECISION_LABEL: Record<CorrectionDecisionValue, string> = {
  approved: "Approve",
  rejected: "Reject",
};

function listButtonClass(selected: boolean): string {
  return (
    "w-full rounded-md border p-3 text-left transition-colors " +
    (selected ? "border-sky-500 bg-sky-500/10" : "border-slate-800 bg-slate-950/40 hover:bg-slate-800/40")
  );
}

function Timestamp({ value }: { value: string }) {
  return (
    <span title={value} className="font-mono text-xs text-slate-500">
      {new Date(value).toLocaleString()}
    </span>
  );
}

/** The rationale box every queue requires before a decision can be recorded. */
function RationaleField({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-xs text-slate-400">
        Rationale (required)
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        placeholder="Explain the decision for the audit record."
        className={"mt-1 " + FIELD_CLASS}
      />
    </div>
  );
}

function QueueList({ children }: { children: ReactNode }) {
  return <ul className="space-y-2">{children}</ul>;
}

function QueuePane({ children }: { children: ReactNode }) {
  return (
    <div className={PANE_CLASS}>
      {children ? children : <SectionMessage tone="muted">Select an entry to review it.</SectionMessage>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 1. Vacancy moderation queue (moderation_cases)
 * ------------------------------------------------------------------------ */

function VacancyQueueCard() {
  const [queue, setQueue] = useState<ModerationQueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setLoading(false);
      return;
    }

    const result = await getModerationQueue(accessToken);
    if (result.kind === "success") {
      setQueue(result.entries);
      setSelectedCaseId((current) =>
        current && result.entries.some((entry) => entry.caseId === current) ? current : null,
      );
      setError(null);
    } else if (result.kind === "forbidden") {
      setError(FORBIDDEN_MESSAGE);
    } else {
      setError(result.message);
    }

    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const selectedCase = queue?.find((entry) => entry.caseId === selectedCaseId) ?? null;

  async function decide(decision: ModerationDecisionValue) {
    if (!selectedCase || rationale.trim() === "") {
      setError("Select a case and enter a rationale first.");
      return;
    }

    setBusy(true);
    setError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await submitModerationDecision(selectedCase.caseId, decision, rationale.trim(), accessToken);
    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedCaseId(null);
      await load();
    }

    setBusy(false);
  }

  return (
    <AdminCard
      title="Vacancy moderation queue"
      description="Open cases from moderation_cases with no decision yet."
      action={<RefreshButton onClick={() => void load()} busy={loading} />}
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      {queue === null ? (
        <SectionMessage tone="muted">Loading…</SectionMessage>
      ) : queue.length === 0 ? (
        <SectionMessage tone="muted">No open cases.</SectionMessage>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <QueueList>
            {queue.map((entry) => (
              <li key={entry.caseId}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCaseId(entry.caseId);
                    setRationale("");
                    setError(null);
                  }}
                  aria-current={entry.caseId === selectedCaseId ? "true" : undefined}
                  className={listButtonClass(entry.caseId === selectedCaseId)}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold uppercase tracking-wide text-slate-400">{entry.severity}</span>
                    <span className="text-slate-600">{entry.sourceType}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-200">{entry.vacancyTitle || "(untitled)"}</p>
                  <span className="mt-1 block text-xs text-slate-600">
                    Opened <Timestamp value={entry.createdAt} />
                  </span>
                </button>
              </li>
            ))}
          </QueueList>

          <QueuePane>
            {selectedCase && (
              <div className="space-y-3">
                <a
                  href={safeVacancyHref(selectedCase.vacancyUrl)}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-xs text-sky-400 underline"
                >
                  {selectedCase.vacancyUrl}
                </a>
                <pre className="max-h-40 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-400">
                  {JSON.stringify(selectedCase.evidenceSnapshot, null, 2)}
                </pre>
                <RationaleField id="vacancy-rationale" value={rationale} onChange={setRationale} />
                <div className="flex flex-wrap gap-2">
                  {MODERATION_DECISIONS.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(decision)}
                      className={BUTTON_CLASS}
                    >
                      {DECISION_LABEL[decision]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </QueuePane>
        </div>
      )}
    </AdminCard>
  );
}

/* ---------------------------------------------------------------------------
 * 2. Employer claims (R5.4a)
 * ------------------------------------------------------------------------ */

function EmployerClaimsCard() {
  const [queue, setQueue] = useState<EmployerClaimQueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setLoading(false);
      return;
    }

    const result = await getEmployerClaimsQueue(accessToken);
    if (result.kind === "success") {
      setQueue(result.entries);
      setSelectedId((current) => (current && result.entries.some((entry) => entry.id === current) ? current : null));
      setError(null);
    } else if (result.kind === "forbidden") {
      setError(FORBIDDEN_MESSAGE);
    } else {
      setError(result.message);
    }

    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = queue?.find((entry) => entry.id === selectedId) ?? null;

  async function decide(decision: EmployerClaimDecisionValue) {
    if (!selected || rationale.trim() === "") {
      setError("Select a claim and enter a rationale first.");
      return;
    }

    setBusy(true);
    setError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await submitEmployerClaimDecision(selected.id, decision, rationale.trim(), accessToken);
    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedId(null);
      await load();
    }

    setBusy(false);
  }

  return (
    <AdminCard
      title="Employer claims"
      description="Pending employer_claims rows. Verifying one is what authorizes that employer to correct the company's facts and appeal blocked vacancies."
      action={<RefreshButton onClick={() => void load()} busy={loading} />}
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      {queue === null ? (
        <SectionMessage tone="muted">Loading…</SectionMessage>
      ) : queue.length === 0 ? (
        <SectionMessage tone="muted">No pending employer claims.</SectionMessage>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <QueueList>
            {queue.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(entry.id);
                    setRationale("");
                    setError(null);
                  }}
                  aria-current={entry.id === selectedId ? "true" : undefined}
                  className={listButtonClass(entry.id === selectedId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-slate-200">{entry.companyName}</span>
                    {entry.domainVerified && (
                      <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
                        Domain match
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {entry.representativeName} — {entry.representativeRole}
                  </p>
                </button>
              </li>
            ))}
          </QueueList>

          <QueuePane>
            {selected && (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">{selected.companyName}</p>
                  <p className="text-xs text-slate-500">
                    {selected.representativeName} — {selected.representativeRole}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Corporate-domain match:{" "}
                    {selected.domainVerified ? "yes (account email domain matches)" : "no — verify independently"}
                  </p>
                </div>

                {selected.evidence && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Evidence</p>
                    <p className="mt-1 whitespace-pre-wrap rounded bg-slate-900 p-2 text-xs text-slate-300">
                      {selected.evidence}
                    </p>
                  </div>
                )}

                <RationaleField id="claim-rationale" value={rationale} onChange={setRationale} />

                <div className="flex flex-wrap gap-2">
                  {EMPLOYER_CLAIM_DECISIONS.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(decision)}
                      className={BUTTON_CLASS}
                    >
                      {CLAIM_DECISION_LABEL[decision]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </QueuePane>
        </div>
      )}
    </AdminCard>
  );
}

/* ---------------------------------------------------------------------------
 * 3. Company fact corrections (R5.4b)
 * ------------------------------------------------------------------------ */

function CompanyFactCorrectionsCard() {
  const [queue, setQueue] = useState<CompanyFactCorrectionQueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setLoading(false);
      return;
    }

    const result = await getCompanyFactCorrectionsQueue(accessToken);
    if (result.kind === "success") {
      setQueue(result.entries);
      setSelectedId((current) => (current && result.entries.some((entry) => entry.id === current) ? current : null));
      setError(null);
    } else if (result.kind === "forbidden") {
      setError(FORBIDDEN_MESSAGE);
    } else {
      setError(result.message);
    }

    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = queue?.find((entry) => entry.id === selectedId) ?? null;

  async function decide(decision: CorrectionDecisionValue) {
    if (!selected || rationale.trim() === "") {
      setError("Select a correction and enter a rationale first.");
      return;
    }

    setBusy(true);
    setError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    const result = await submitCorrectionDecision(selected.id, decision, rationale.trim(), accessToken);
    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedId(null);
      await load();
    }

    setBusy(false);
  }

  return (
    <AdminCard
      title="Company fact corrections"
      description="Pending company_fact_corrections rows. Approving one applies the proposed value to the company's profile."
      action={<RefreshButton onClick={() => void load()} busy={loading} />}
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      {queue === null ? (
        <SectionMessage tone="muted">Loading…</SectionMessage>
      ) : queue.length === 0 ? (
        <SectionMessage tone="muted">No pending fact corrections.</SectionMessage>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <QueueList>
            {queue.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(entry.id);
                    setRationale("");
                    setError(null);
                  }}
                  aria-current={entry.id === selectedId ? "true" : undefined}
                  className={listButtonClass(entry.id === selectedId)}
                >
                  <p className="text-sm text-slate-200">{entry.companyName}</p>
                  <p className="mt-1 text-xs text-slate-500">{CORRECTABLE_FIELD_LABELS[entry.fieldName]}</p>
                </button>
              </li>
            ))}
          </QueueList>

          <QueuePane>
            {selected && (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">{selected.companyName}</p>
                  <p className="text-xs text-slate-500">{CORRECTABLE_FIELD_LABELS[selected.fieldName]}</p>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="uppercase tracking-wide text-slate-500">Current value</p>
                    <p className="mt-1 text-slate-400">{selected.currentValue ?? "(not set)"}</p>
                  </div>
                  <div>
                    <p className="uppercase tracking-wide text-slate-500">Proposed value</p>
                    <p className="mt-1 text-slate-200">{selected.proposedValue}</p>
                  </div>
                </div>

                {selected.evidence && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Evidence</p>
                    <p className="mt-1 whitespace-pre-wrap rounded bg-slate-900 p-2 text-xs text-slate-300">
                      {selected.evidence}
                    </p>
                  </div>
                )}

                <RationaleField id="correction-rationale" value={rationale} onChange={setRationale} />

                <div className="flex flex-wrap gap-2">
                  {CORRECTION_DECISIONS.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(decision)}
                      className={BUTTON_CLASS}
                    >
                      {CORRECTION_DECISION_LABEL[decision]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </QueuePane>
        </div>
      )}
    </AdminCard>
  );
}

/* ---------------------------------------------------------------------------
 * 4. Vacancy appeals (R5.4c)
 * ------------------------------------------------------------------------ */

function AppealsCard() {
  const [queue, setQueue] = useState<AppealQueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setLoading(false);
      return;
    }

    const result = await getAppealsQueue(accessToken);
    if (result.kind === "success") {
      setQueue(result.entries);
      setSelectedCaseId((current) =>
        current && result.entries.some((entry) => entry.caseId === current) ? current : null,
      );
      setError(null);
    } else if (result.kind === "forbidden") {
      setError(FORBIDDEN_MESSAGE);
    } else {
      setError(result.message);
    }

    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = queue?.find((entry) => entry.caseId === selectedCaseId) ?? null;

  async function decide(decision: ModerationDecisionValue) {
    if (!selected || rationale.trim() === "") {
      setError("Select an appeal and enter a rationale first.");
      return;
    }

    setBusy(true);
    setError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setError("Your session has expired.");
      setBusy(false);
      return;
    }

    // appealId is what links this decision to the appeal it resolves; without it
    // the case is decided but the appeal stays open.
    const result = await submitModerationDecision(
      selected.caseId,
      decision,
      rationale.trim(),
      accessToken,
      fetch,
      selected.appealId,
    );

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setRationale("");
      setSelectedCaseId(null);
      await load();
    }

    setBusy(false);
  }

  return (
    <AdminCard
      title="Vacancy appeals"
      description="Appeals an employer filed against a blocked vacancy. Deciding one resolves the appeal alongside the case."
      action={<RefreshButton onClick={() => void load()} busy={loading} />}
    >
      {error && <SectionMessage tone="error">{error}</SectionMessage>}

      {queue === null ? (
        <SectionMessage tone="muted">Loading…</SectionMessage>
      ) : queue.length === 0 ? (
        <SectionMessage tone="muted">No pending appeals.</SectionMessage>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <QueueList>
            {queue.map((entry) => (
              <li key={entry.caseId}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCaseId(entry.caseId);
                    setRationale("");
                    setError(null);
                  }}
                  aria-current={entry.caseId === selectedCaseId ? "true" : undefined}
                  className={listButtonClass(entry.caseId === selectedCaseId)}
                >
                  <p className="text-sm text-slate-200">{entry.vacancyTitle || "(untitled)"}</p>
                  {entry.evidenceDeadline && (
                    <p className="mt-1 text-xs text-slate-500">Evidence due {entry.evidenceDeadline}</p>
                  )}
                </button>
              </li>
            ))}
          </QueueList>

          <QueuePane>
            {selected && (
              <div className="space-y-3">
                <a
                  href={safeVacancyHref(selected.vacancyUrl)}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-xs text-sky-400 underline"
                >
                  {selected.vacancyUrl}
                </a>

                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Original decision</p>
                  <p className="mt-1 rounded bg-slate-900 p-2 text-xs text-slate-300">
                    {selected.originalDecisionRationale}{" "}
                    <span className="text-slate-500">(policy {selected.originalDecisionPolicyVersion})</span>
                  </p>
                </div>

                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Employer appeal</p>
                  <p className="mt-1 whitespace-pre-wrap rounded bg-slate-900 p-2 text-xs text-slate-300">
                    {selected.appealRationale}
                  </p>
                  {selected.appealEvidence != null && (
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-400">
                      {JSON.stringify(selected.appealEvidence, null, 2)}
                    </pre>
                  )}
                </div>

                <RationaleField id="appeal-rationale" value={rationale} onChange={setRationale} />

                <div className="flex flex-wrap gap-2">
                  {MODERATION_DECISIONS.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      disabled={busy}
                      onClick={() => void decide(decision)}
                      className={BUTTON_CLASS}
                    >
                      {APPEAL_DECISION_LABEL[decision]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </QueuePane>
        </div>
      )}
    </AdminCard>
  );
}

/**
 * R8.1's "Moderation Queue" section is all four moderation queues, each with its
 * own refresh. A single Refresh was rejected: the queues drain at different
 * rates, and re-reading three unchanged ones because the fourth changed is
 * noise on a page whose whole purpose is seeing what moved.
 */
export function ModerationSection() {
  return (
    <div className="space-y-4">
      <VacancyQueueCard />
      <EmployerClaimsCard />
      <CompanyFactCorrectionsCard />
      <AppealsCard />
    </div>
  );
}
