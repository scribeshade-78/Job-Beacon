import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * The panel's real interaction: search -> phrase confirmation -> save arguments,
 * duplicate messaging, replacement, and honest failure.
 *
 * The DATA LAYER is mocked so the emitted save arguments are assertable; search,
 * related-role resolution and the qualifier label are the real implementations.
 * These are DOM assertions, not browser verification, and the mocked layer means
 * nothing here exercises the database or RLS.
 */

const api = vi.hoisted(() => ({
  listSelectedRoles: vi.fn(),
  selectRole: vi.fn(),
  replaceRoleIntent: vi.fn(),
  removeRole: vi.fn(),
}));

vi.mock("../lib/candidateSelectedRoles", () => api);
vi.mock("../lib/resumeExtraction", () => ({
  listExtractedFacts: vi.fn(async () => ({ kind: "success", facts: [] })),
}));
vi.mock("../lib/supabaseClient", () => ({ getSupabaseBrowserClient: () => ({}) }));

const rankingApi = vi.hoisted(() => ({ runRankingRefresh: vi.fn() }));

vi.mock("../lib/feedRankingRefresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/feedRankingRefresh")>();
  return { ...actual, runRankingRefresh: rankingApi.runRankingRefresh };
});

import { TargetRolesPanel } from "./TargetRolesPanel";

function selected(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "role-1",
    roleName: "Data Engineer",
    rawRoleName: "Azure Data Engineer",
    normalizedRoleId: "data-engineer",
    createdAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  api.listSelectedRoles.mockResolvedValue({ kind: "success", roles: [] });
  api.selectRole.mockResolvedValue({ kind: "success" });
  api.replaceRoleIntent.mockResolvedValue({ kind: "success" });
  api.removeRole.mockResolvedValue({ kind: "success" });
  // Default: the bounded poll simply hit its cap. Individual tests override it.
  rankingApi.runRankingRefresh.mockResolvedValue({ kind: "timeout", result: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function search(text: string) {
  fireEvent.change(screen.getByLabelText("Search target roles"), { target: { value: text } });
  await screen.findByText(/Save this preference?/);
}

describe("phrase confirmation", () => {
  it("shows the canonical occupation and the preference wording, and does not save on its own", async () => {
    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    await search("Azure Data Engineer");

    expect(screen.getByText(/maps to/)).toBeTruthy();
    // "preferred", not "only".
    expect(screen.getByText(/Azure preferred/)).toBeTruthy();
    expect(api.selectRole).not.toHaveBeenCalled();
  });

  it("saves the confirmed phrase with its normalized id on explicit confirmation", async () => {
    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    await search("Azure Data Engineer");
    fireEvent.click(screen.getByRole("button", { name: /Save “Azure Data Engineer” as Data Engineer/ }));

    await waitFor(() =>
      expect(api.selectRole).toHaveBeenCalledWith(expect.anything(), "candidate-1", "Data Engineer", {
        rawRoleName: "Azure Data Engineer",
        normalizedRoleId: "data-engineer",
      }),
    );
  });

  it("does not offer a preference when the query adds nothing to the canonical role", async () => {
    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    fireEvent.change(screen.getByLabelText("Search target roles"), { target: { value: "Data Engineer" } });

    await screen.findByText("Data Engineer");
    expect(screen.queryByText(/Save this preference?/)).toBeNull();
  });
});

describe("related roles", () => {
  it("renders the authored explanation and only selects on an explicit add", async () => {
    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    // No phrase confirmation here: "Accountant" adds nothing to the canonical
    // role, so only the related block appears.
    fireEvent.change(screen.getByLabelText("Search target roles"), { target: { value: "Accountant" } });
    await screen.findByText("Related roles");

    expect(screen.getByText("Related roles")).toBeTruthy();
    expect(screen.getByText(/Bookkeeping records day-to-day transactions/)).toBeTruthy();
    expect(api.selectRole).not.toHaveBeenCalled();

    // The related entry has its own Add; nothing is selected automatically.
    const relatedHeading = screen.getByText("Bookkeeper");
    expect(relatedHeading).toBeTruthy();
  });
});

describe("saved intent", () => {
  it("displays the recorded phrase and its preference after reload", async () => {
    api.listSelectedRoles.mockResolvedValue({ kind: "success", roles: [selected()] });

    render(<TargetRolesPanel candidateId="candidate-1" />);

    expect(await screen.findByText(/Asked for "Azure Data Engineer"/)).toBeTruthy();
    expect(screen.getByText(/Azure preferred/)).toBeTruthy();
  });

  it("reports a legacy row as NOT RECORDED rather than inventing intent", async () => {
    api.listSelectedRoles.mockResolvedValue({
      kind: "success",
      roles: [selected({ rawRoleName: null, normalizedRoleId: null })],
    });

    render(<TargetRolesPanel candidateId="candidate-1" />);

    expect(await screen.findByText("Preference not recorded")).toBeTruthy();
  });

  it("does not claim a new phrase was saved when the role already exists", async () => {
    api.listSelectedRoles.mockResolvedValue({ kind: "success", roles: [selected({ rawRoleName: null })] });

    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText("Preference not recorded");

    fireEvent.change(screen.getByLabelText("Search target roles"), { target: { value: "Azure Data Engineer" } });
    fireEvent.click(await screen.findByRole("button", { name: /Save “Azure Data Engineer” as Data Engineer/ }));

    expect(await screen.findByText(/already in your list/)).toBeTruthy();
    // The duplicate path never writes, so it cannot report a false save.
    expect(api.selectRole).not.toHaveBeenCalled();
  });
});

describe("editing the preference", () => {
  it("replaces the phrase deliberately", async () => {
    api.listSelectedRoles.mockResolvedValue({ kind: "success", roles: [selected({ rawRoleName: null })] });

    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText("Preference not recorded");

    fireEvent.click(screen.getByRole("button", { name: "Edit preference" }));
    fireEvent.change(screen.getByLabelText("Preferred phrase for Data Engineer"), {
      target: { value: "Azure Data Engineer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save preference" }));

    await waitFor(() =>
      expect(api.replaceRoleIntent).toHaveBeenCalledWith(expect.anything(), "role-1", {
        rawRoleName: "Azure Data Engineer",
        normalizedRoleId: "data-engineer",
      }),
    );
  });

  it("clears the preference explicitly", async () => {
    api.listSelectedRoles.mockResolvedValue({ kind: "success", roles: [selected()] });

    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/Asked for "Azure Data Engineer"/);

    fireEvent.click(screen.getByRole("button", { name: "Edit preference" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear preference" }));

    await waitFor(() =>
      expect(api.replaceRoleIntent).toHaveBeenCalledWith(expect.anything(), "role-1", {
        rawRoleName: "",
        normalizedRoleId: "data-engineer",
      }),
    );
  });
});

describe("failures", () => {
  it("keeps the candidate's input and shows no success when a save fails", async () => {
    api.selectRole.mockResolvedValue({ kind: "error", message: "Could not update your target roles. Please try again." });

    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    await search("Azure Data Engineer");
    fireEvent.click(screen.getByRole("button", { name: /Save “Azure Data Engineer” as Data Engineer/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The query survives the failure.
    expect((screen.getByLabelText("Search target roles") as HTMLInputElement).value).toBe("Azure Data Engineer");
  });
});

describe("custom roles", () => {
  it("adds an unmatched query as a custom role, keeping the candidate's own words", async () => {
    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    fireEvent.change(screen.getByLabelText("Search target roles"), { target: { value: "Marine Biologist" } });
    fireEvent.click(await screen.findByRole("button", { name: /as a custom role/ }));

    await waitFor(() =>
      expect(api.selectRole).toHaveBeenCalledWith(expect.anything(), "candidate-1", "Marine Biologist"),
    );
  });
});

describe("ranking refresh reporting", () => {
  it("reports the SAVE as succeeded even when the follow-up ranking refresh fails", async () => {
    rankingApi.runRankingRefresh.mockResolvedValue({
      kind: "done",
      result: {
        outcome: "failed",
        phase: "matching",
        state: "updating",
        identity: "id-1",
        attempts: 1,
        retryable: true,
        lastError: "db down",
        deadlineReached: false,
      },
    });

    render(<TargetRolesPanel candidateId="candidate-1" />);
    await screen.findByText(/No target roles yet/);

    await search("Azure Data Engineer");
    fireEvent.click(screen.getByRole("button", { name: /Save “Azure Data Engineer” as Data Engineer/ }));

    // The save happened and IS reported; the refresh is a separate, retryable line.
    await waitFor(() => expect(api.selectRole).toHaveBeenCalled());
    await waitFor(() => expect(rankingApi.runRankingRefresh).toHaveBeenCalledWith(expect.objectContaining({ force: true })));
    expect(await screen.findByText(/Preference ranking could not be updated/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    // NEVER re-reported as a save failure.
    expect(screen.queryByText(/Could not update your target roles/i)).toBeNull();
  });
});
