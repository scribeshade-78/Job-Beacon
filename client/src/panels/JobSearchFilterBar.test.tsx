import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JobSearchFilterBar,
  SEARCH_SCOPE_OPTIONS,
  countDraftFilters,
  emptyJobSearchDraft,
  pillUnavailableReason,
  sameJobSearch,
  type JobSearchDraft,
} from "./JobSearchFilterBar";
import { VACANCY_FILTERS } from "../../../shared/opportunityQuery";

// vitest.config.ts does not enable globals, so RTL's automatic cleanup never registers.
afterEach(cleanup);

function draft(): JobSearchDraft {
  return emptyJobSearchDraft();
}

function form() {
  return screen.getByRole("form", { name: "Job search filters" });
}

describe("JobSearchFilterBar", () => {
  it("renders the search row, the exclusion row and all ten pills", () => {
    render(<JobSearchFilterBar value={draft()} onApply={vi.fn()} />);

    expect(screen.getByLabelText("Search scope")).toBeInTheDocument();
    expect(screen.getByLabelText("Search by title or keyword")).toBeInTheDocument();
    expect(screen.getByLabelText("Exclude keywords")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Exclude keywords (Hide jobs mentioning...)")).toBeInTheDocument();

    for (const label of [
      "Date",
      "Location",
      "Workplace",
      "Companies",
      "Degree Level",
      "Max Experience",
      "Sponsors Visa",
      "Role",
      "Job Type",
      "Employment Type",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // The scope dropdown offers the three modes from the brief.
    expect(SEARCH_SCOPE_OPTIONS.map((option) => option.label)).toEqual([
      "Title + Description",
      "Title only",
      "Company",
    ]);
  });

  it("does not emit anything while the user types", () => {
    const onApply = vi.fn();
    render(<JobSearchFilterBar value={draft()} onApply={onApply} />);

    fireEvent.change(screen.getByLabelText("Search by title or keyword"), {
      target: { value: "data engineer" },
    });
    fireEvent.change(screen.getByLabelText("Exclude keywords"), {
      target: { value: "unpaid" },
    });

    // THE WHOLE POINT OF THE COMPONENT: four edits, zero requests.
    expect(onApply).not.toHaveBeenCalled();
  });

  it("emits the draft exactly once when Apply is pressed", () => {
    const onApply = vi.fn();
    render(<JobSearchFilterBar value={draft()} onApply={onApply} />);

    fireEvent.change(screen.getByLabelText("Search by title or keyword"), {
      target: { value: "data engineer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    expect(onApply).toHaveBeenCalledTimes(1);

    const emitted = onApply.mock.calls[0][0] as JobSearchDraft;
    expect(emitted.query).toBe("data engineer");
    expect(emitted.scope).toBe("title_description");
    expect(emitted.filters).toEqual(draft().filters);
  });

  it("applies on Enter in the search field, because a search box that will not submit is broken", () => {
    const onApply = vi.fn();
    render(<JobSearchFilterBar value={draft()} onApply={onApply} />);

    const input = screen.getByLabelText("Search by title or keyword");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.submit(form());

    expect(onApply).toHaveBeenCalledTimes(1);
    expect((onApply.mock.calls[0][0] as JobSearchDraft).query).toBe("rust");
  });

  it("keeps Apply disabled until something actually changed", () => {
    render(<JobSearchFilterBar value={draft()} onApply={vi.fn()} />);

    const apply = screen.getByRole("button", { name: /^Apply/ });
    expect(apply).toBeDisabled();
  });

  it("re-syncs the draft when the committed search changes underneath it", () => {
    const { rerender } = render(<JobSearchFilterBar value={draft()} onApply={vi.fn()} />);

    const next: JobSearchDraft = { ...draft(), query: "restored from url" };
    rerender(<JobSearchFilterBar value={next} onApply={vi.fn()} />);

    expect(screen.getByLabelText("Search by title or keyword")).toHaveValue("restored from url");
  });

  it("shows why an unbacked pill cannot filter instead of pretending it can", () => {
    const location = VACANCY_FILTERS.find((entry) => entry.id === "location");
    expect(location?.columns).toEqual([]);
    expect(pillUnavailableReason({ id: "location", label: "Location", field: "location" })).toBe(
      location?.unavailableReason,
    );

    // A category with no spec entry at all gets an explicit reason too.
    expect(
      pillUnavailableReason({ id: "visa", label: "Sponsors Visa", missingReason: "no visa column" }),
    ).toBe("no visa column");

    // The backed ones are open, including the four carried over from the old bar.
    expect(pillUnavailableReason({ id: "date", label: "Date", field: "freshness" })).toBeNull();
    expect(pillUnavailableReason({ id: "companies", label: "Companies", field: "company" })).toBeNull();

    for (const field of ["salary", "trust", "application_status", "source"] as const) {
      expect(pillUnavailableReason({ id: field, label: field, field })).toBeNull();
    }
  });

  it("edits Trust in the draft and still emits nothing until Apply", () => {
    const onApply = vi.fn();
    render(<JobSearchFilterBar value={draft()} onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: /^Trust/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Verified$/ }));

    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect((onApply.mock.calls[0][0] as JobSearchDraft).filters.trustStatuses).toEqual(["VERIFIED"]);
  });

  it("counts what the draft narrows by, and compares drafts field-wise", () => {
    expect(countDraftFilters(draft())).toBe(0);

    const narrowed: JobSearchDraft = {
      ...draft(),
      query: "analyst",
      filters: { ...draft().filters, freshness: "7", workModes: ["remote"], companies: ["Acme"] },
    };

    expect(countDraftFilters(narrowed)).toBe(4);
    expect(sameJobSearch(narrowed, draft())).toBe(false);
    expect(sameJobSearch(narrowed, { ...narrowed })).toBe(true);
  });
});
