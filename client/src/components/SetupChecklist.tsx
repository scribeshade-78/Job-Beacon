import { useEffect, useState } from "react";
import { Link } from "wouter";
import { readinessHeadline, type SetupStep } from "../../../shared/readiness";
import {
  AUTOMATION_CONSENT_ANCHOR_ID,
  fetchReadiness,
  type FetchReadinessDeps,
  type ReadinessState,
} from "../lib/readiness";
import { Button, buttonVariants } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

/**
 * The visible setup checklist (Phase 0 Task 2's four steps), rendered on Home.
 *
 * IT RENDERS THE SHARED MODEL, IT DOES NOT RESTATE IT. Every label, detail
 * sentence, action and headline comes from shared/readiness.ts, so this card and
 * the server gate cannot disagree about what "set up" means.
 *
 * FAIL CLOSED. Loading is a text-free skeleton and an error is an explicit
 * message with a retry; neither state can render "Complete", "Active" or
 * "Authorized", because those are claims only a server payload can justify.
 */
export function SetupChecklist({ deps }: { deps?: FetchReadinessDeps }) {
  const [state, setState] = useState<ReadinessState>({ kind: "loading" });

  async function load() {
    setState({ kind: "loading" });
    setState(await fetchReadiness(deps));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <SetupChecklistView state={state} onRetry={() => void load()} />;
}

export function SetupChecklistView({ state, onRetry }: { state: ReadinessState; onRetry: () => void }) {
  return (
    <Card aria-labelledby="setup-checklist-title">
      <CardHeader>
        <CardTitle id="setup-checklist-title">Setup checklist</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === "loading" && <SetupChecklistSkeleton />}

        {state.kind === "error" && (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-status-blocked-fg">{state.message}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <p className="text-sm font-medium text-black">{readinessHeadline(state.readiness)}</p>
            <ol className="mt-4 space-y-4">
              {state.readiness.steps.map((step) => (
                <SetupChecklistStep key={step.id} step={step} />
              ))}
            </ol>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Text-free on purpose: a pending checklist must not assert any state. */
function SetupChecklistSkeleton() {
  return (
    <div data-testid="setup-checklist-skeleton" aria-busy="true" className="space-y-4">
      <div className="h-5 w-64 animate-pulse rounded bg-ios-separator" />
      <ul className="space-y-4">
        {[0, 1, 2, 3].map((index) => (
          <li key={index} className="flex items-center gap-3">
            <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-ios-separator" />
            <div className="h-4 w-40 animate-pulse rounded bg-ios-separator" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SetupChecklistStep({ step }: { step: SetupStep }) {
  const action = step.action;

  return (
    <li className="flex items-start gap-3" data-state={step.complete ? "complete" : "incomplete"}>
      {/* Icon AND word, so completion never depends on colour alone. */}
      <span
        aria-hidden="true"
        className={
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-sm font-bold " +
          (step.complete
            ? "border-green-700 bg-green-100 text-green-800"
            : "border-ios-separator bg-ios-bg text-ios-text-secondary")
        }
      >
        {step.complete ? "\u2713" : "\u25cb"}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-black">
          {step.label}
          <span className="ml-2 text-xs font-normal text-ios-text-secondary">
            {step.complete ? "Complete" : "Incomplete"}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-ios-text-secondary">{step.detail}</p>
        {step.timestamp && (
          <p className="mt-0.5 text-xs text-ios-text-secondary">
            <time dateTime={step.timestamp}>{formatStepTimestamp(step.timestamp)}</time>
          </p>
        )}
      </div>

      {action && action.route !== null && (
        <Link href={action.route} className={buttonVariants("secondary", "sm")}>
          {action.label}
        </Link>
      )}

      {action && action.route === null && step.id === "submission_consent" && (
        <Button variant="secondary" size="sm" onClick={scrollToConsentControls}>
          {action.label}
        </Button>
      )}
    </li>
  );
}

function scrollToConsentControls() {
  if (typeof document === "undefined") {
    return;
  }

  const target = document.getElementById(AUTOMATION_CONSENT_ANCHOR_ID);

  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/** A stable date. The exact locale text is not part of the contract. */
function formatStepTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
