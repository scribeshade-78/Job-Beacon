import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import type { Readiness, SetupStep } from "../../../shared/readiness";
import type { ReadinessState } from "../lib/readiness";
import { SetupChecklist, SetupChecklistView } from "./SetupChecklist";

afterEach(() => {
  cleanup();
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});

function step(over: Partial<SetupStep> & { id: SetupStep["id"] }): SetupStep {
  return { label: over.id, complete: false, detail: "detail", action: null, timestamp: null, ...over };
}

const INCOMPLETE_STEPS: SetupStep[] = [
  step({ id: "resume", label: "Resume", detail: "Upload a resume", action: { label: "Upload resume", route: "/resumes" } }),
  step({ id: "target_roles", label: "Target roles", detail: "No target roles selected", action: { label: "Choose target roles", route: "/target-roles" } }),
  step({ id: "search_preferences", label: "Search preferences", detail: "Tell us where you want to work", action: { label: "Complete search preferences", route: "/profile" } }),
  step({ id: "submission_consent", label: "Submission consent", detail: "Submission consent not granted", action: { label: "Review submission consent", route: null } }),
];

const COMPLETE_STEPS: SetupStep[] = ["resume", "target_roles", "search_preferences", "submission_consent"].map((id) =>
  step({ id: id as SetupStep["id"], label: id, complete: true, detail: "done", action: null }),
);

function makeReadiness(over: Partial<Readiness> = {}): Readiness {
  return {
    resumeReady: false,
    rolesReady: false,
    preferencesReady: false,
    consentReady: false,
    completedSteps: 0,
    totalSteps: 4,
    setupComplete: false,
    discoveryAvailable: false,
    reviewQueueAvailable: false,
    submissionAvailable: false,
    automationControlsAvailable: false,
    blockers: [],
    primaryState: "setup_incomplete",
    steps: INCOMPLETE_STEPS,
    ...over,
  };
}

function renderView(state: ReadinessState, onRetry: () => void = () => {}) {
  return render(
    <Router hook={useHashLocation}>
      <SetupChecklistView state={state} onRetry={onRetry} />
    </Router>,
  );
}

const ALL_DONE = {
  completedSteps: 4,
  totalSteps: 4,
  setupComplete: true,
  resumeReady: true,
  rolesReady: true,
  preferencesReady: true,
  consentReady: true,
  steps: COMPLETE_STEPS,
};

describe("SetupChecklistView", () => {
  it("renders 0 of 4 complete when nothing is done", () => {
    renderView({ kind: "ready", readiness: makeReadiness() });

    expect(screen.getByText("Setup incomplete · 0 of 4 complete")).toBeTruthy();
  });

  it("renders 2 of 4 complete for a partially set-up candidate", () => {
    const steps = INCOMPLETE_STEPS.map((entry, index) =>
      index < 2 ? { ...entry, complete: true, action: null } : entry,
    );

    renderView({
      kind: "ready",
      readiness: makeReadiness({ completedSteps: 2, resumeReady: true, rolesReady: true, steps }),
    });

    expect(screen.getByText("Setup incomplete · 2 of 4 complete")).toBeTruthy();
  });

  it("renders the plan_not_eligible state for a completed Free candidate", () => {
    renderView({ kind: "ready", readiness: makeReadiness({ ...ALL_DONE, primaryState: "plan_not_eligible" }) });

    expect(screen.getByText("Setup complete · Your plan does not include automation")).toBeTruthy();
  });

  it("renders ready_for_review_queue for a completed, entitled, capable candidate", () => {
    renderView({ kind: "ready", readiness: makeReadiness({ ...ALL_DONE, primaryState: "ready_for_review_queue" }) });

    expect(screen.getByText("Ready for application review")).toBeTruthy();
  });

  it("labels completion in words, so it never depends on colour alone", () => {
    const steps = INCOMPLETE_STEPS.map((entry, index) =>
      index === 0 ? { ...entry, complete: true, action: null } : entry,
    );

    renderView({ kind: "ready", readiness: makeReadiness({ completedSteps: 1, resumeReady: true, steps }) });

    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.getAllByText("Incomplete")).toHaveLength(3);
  });

  it("routes each action to its path, and scrolls the consent step to its anchor", () => {
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;

    render(
      <Router hook={useHashLocation}>
        <div id="automation-consent" />
        <SetupChecklistView state={{ kind: "ready", readiness: makeReadiness() }} onRetry={() => {}} />
      </Router>,
    );

    expect(screen.getByRole("link", { name: "Upload resume" }).getAttribute("href")).toContain("/resumes");
    expect(screen.getByRole("link", { name: "Choose target roles" }).getAttribute("href")).toContain("/target-roles");
    expect(screen.getByRole("link", { name: "Complete search preferences" }).getAttribute("href")).toContain("/profile");

    fireEvent.click(screen.getByRole("button", { name: "Review submission consent" }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("renders a timestamp only when the step has one", () => {
    const steps = INCOMPLETE_STEPS.map((entry, index) =>
      index === 0 ? { ...entry, complete: true, action: null, timestamp: "2026-09-01T10:00:00.000Z" } : entry,
    );

    const view = renderView({
      kind: "ready",
      readiness: makeReadiness({ completedSteps: 1, resumeReady: true, steps }),
    });

    const times = view.container.querySelectorAll("time");
    expect(times).toHaveLength(1);
    expect(times[0].getAttribute("datetime")).toBe("2026-09-01T10:00:00.000Z");

    cleanup();
    const without = renderView({ kind: "ready", readiness: makeReadiness() });
    expect(without.container.querySelectorAll("time")).toHaveLength(0);
  });
});

describe("SetupChecklist", () => {
  it("shows a text-free skeleton while pending and never flashes an automation state", () => {
    render(
      <Router hook={useHashLocation}>
        <SetupChecklist
          deps={{ fetchImpl: (() => new Promise(() => {})) as never, getAccessToken: async () => "token" }}
        />
      </Router>,
    );

    expect(screen.getByTestId("setup-checklist-skeleton")).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("Authorized")).toBeNull();
    expect(screen.queryByText("Complete")).toBeNull();
  });

  it("renders an explicit error state, never ready, when the read fails", async () => {
    render(
      <Router hook={useHashLocation}>
        <SetupChecklist
          deps={{
            fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as never,
            getAccessToken: async () => "token",
          }}
        />
      </Router>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("couldn't be checked");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/Complete/)).toBeNull();
  });
});
