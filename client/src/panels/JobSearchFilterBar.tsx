import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  FRESHNESS_WINDOWS,
  REMOTE_PREFERENCE_OPTIONS,
  VACANCY_FILTERS,
  type FilterFieldId,
} from "../../../shared/opportunityQuery";
import { EMPTY_FILTERS, type OpportunityFilters } from "../lib/opportunityQuery";
import { parseListInput } from "../lib/candidatePreferences";
import { INLINE_FOCUS_RING, cn } from "../lib/utils";

/**
 * The job-browsing filter bar, in the shape a modern job board uses: one search row, one exclusion
 * row, a wrapping row of filter pills, and a single Apply action on the right.
 *
 * THE RULE THAT SHAPES EVERY LINE: A CONTROL NEVER TRIGGERS A REQUEST.
 *
 * Every input and every pill edits a LOCAL DRAFT. Nothing is emitted until Apply is pressed, so
 * dragging through four dropdowns costs one query instead of four. That is why this component is
 * uncontrolled by the caller's query and only writes back through onApply.
 *
 * IT DOES NOT INVENT FILTERS. The ten categories in the brief are mapped to the shared spec, and a
 * category with no backing column is rendered as a pill that EXPLAINS why instead of one that
 * silently matches everything. Only Date, Workplace and Companies are backed today; the rest open
 * a reason. When a column lands, adding it to shared/opportunityQuery.ts flips the pill on with no
 * change here.
 */

export type SearchScope = "title_description" | "title" | "company";

export const SEARCH_SCOPE_OPTIONS = [
  { value: "title_description", label: "Title + Description" },
  { value: "title", label: "Title only" },
  { value: "company", label: "Company" },
] as const satisfies ReadonlyArray<{ value: SearchScope; label: string }>;

export interface JobSearchDraft {
  scope: SearchScope;
  query: string;
  exclude: string;
  filters: OpportunityFilters;
}

/** A fresh draft. The filter object is copied so a draft can never mutate EMPTY_FILTERS. */
export function emptyJobSearchDraft(): JobSearchDraft {
  return { scope: "title_description", query: "", exclude: "", filters: { ...EMPTY_FILTERS } };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameFilters(a: OpportunityFilters, b: OpportunityFilters): boolean {
  return (
    a.freshness === b.freshness &&
    a.minSalary === b.minSalary &&
    a.minSalaryCurrency === b.minSalaryCurrency &&
    sameList(a.countries, b.countries) &&
    sameList(a.cities, b.cities) &&
    sameList(a.workModes, b.workModes) &&
    sameList(a.employmentTypes, b.employmentTypes) &&
    sameList(a.seniorities, b.seniorities) &&
    sameList(a.companies, b.companies) &&
    sameList(a.trustStatuses, b.trustStatuses) &&
    sameList(a.applicationStatuses, b.applicationStatuses) &&
    sameList(a.sources, b.sources)
  );
}

/** Deliberately explicit rather than JSON.stringify: key order must not decide whether Apply is enabled. */
export function sameJobSearch(a: JobSearchDraft, b: JobSearchDraft): boolean {
  return a.scope === b.scope && a.query === b.query && a.exclude === b.exclude && sameFilters(a.filters, b.filters);
}

/** How many things the draft is narrowing by — shown on Apply so the count is never a mystery. */
export function countDraftFilters(draft: JobSearchDraft): number {
  const f = draft.filters;
  return (
    (draft.query.trim() ? 1 : 0) +
    (draft.exclude.trim() ? 1 : 0) +
    (f.freshness ? 1 : 0) +
    (f.workModes.length > 0 ? 1 : 0) +
    (f.companies.length > 0 ? 1 : 0) +
    (f.countries.length > 0 ? 1 : 0) +
    (f.cities.length > 0 ? 1 : 0) +
    (f.employmentTypes.length > 0 ? 1 : 0) +
    (f.seniorities.length > 0 ? 1 : 0) +
    (f.trustStatuses.length > 0 ? 1 : 0) +
    (f.applicationStatuses.length > 0 ? 1 : 0) +
    (f.sources.length > 0 ? 1 : 0) +
    (f.minSalary !== null ? 1 : 0)
  );
}

interface PillSpec {
  id: string;
  label: string;
  /** The shared-spec field this pill edits, when one exists. */
  field?: FilterFieldId;
  /** Used when the category has no spec entry at all. */
  missingReason?: string;
}

/**
 * The ten categories from the brief, in order, mapped to what actually exists.
 *
 * TWO OF THEM SHARE A FIELD on purpose: "Job Type" and "Employment Type" would both read an
 * employment-type column, and there is none. Giving each its own reason would imply they were
 * separate gaps rather than one missing column.
 */
const PILL_SPECS: readonly PillSpec[] = [
  { id: "date", label: "Date", field: "freshness" },
  { id: "location", label: "Location", field: "location" },
  { id: "workplace", label: "Workplace", field: "work_mode" },
  { id: "companies", label: "Companies", field: "company" },
  {
    id: "degree",
    label: "Degree Level",
    missingReason:
      "Listings carry no degree requirement, so a degree filter would match nothing. Nothing is declared for it in the query spec either, which is why this control is inert rather than merely disabled.",
  },
  {
    id: "experience",
    label: "Max Experience",
    missingReason:
      "No column records a required years-of-experience, and reading a number out of free-text descriptions would be a guess presented as a filter.",
  },
  {
    id: "visa",
    label: "Sponsors Visa",
    missingReason:
      "Visa sponsorship is almost never stated in a listing, so the filter would silently return nothing. It needs a source that states it before it can exist.",
  },
  {
    id: "role",
    label: "Role",
    missingReason:
      "Vacancy titles are free text from the original listing. Role-shaped matching lives in your saved role preferences, not in a filter over the feed.",
  },
  { id: "job_type", label: "Job Type", field: "employment_type" },
  { id: "employment_type", label: "Employment Type", field: "employment_type" },
];

/** The reason a pill cannot change the query, or null when it can. */
export function pillUnavailableReason(spec: PillSpec): string | null {
  if (!spec.field) {
    return spec.missingReason ?? "This filter is not available yet.";
  }

  const declared = VACANCY_FILTERS.find((entry) => entry.id === spec.field);

  if (!declared) {
    return spec.missingReason ?? "This filter is not declared in the shared query spec.";
  }

  if (declared.columns.length === 0) {
    return declared.unavailableReason ?? "This filter has no backing column yet.";
  }

  return null;
}

const PILL_BASE =
  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors duration-150";
const PILL_IDLE = "border-ios-separator bg-ios-card text-black hover:bg-ios-bg";
const PILL_ACTIVE = "border-ios-blue bg-ios-blue/10 text-ios-blue";

function PillTrigger({
  label,
  count,
  active,
}: {
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <PopoverTrigger asChild>
      <button
        type="button"
        className={cn(PILL_BASE, active ? PILL_ACTIVE : PILL_IDLE, INLINE_FOCUS_RING)}
        aria-haspopup="dialog"
      >
        <span>{label}</span>
        {count > 0 ? (
          <span className="rounded-full bg-ios-blue px-1.5 text-[11px] font-semibold text-white">{count}</span>
        ) : null}
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
    </PopoverTrigger>
  );
}

function OptionRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-sm hover:bg-ios-bg",
        INLINE_FOCUS_RING,
      )}
    >
      <span>{label}</span>
      {selected ? <Check className="h-4 w-4 text-ios-blue" aria-hidden="true" /> : null}
    </button>
  );
}

interface JobSearchFilterBarProps {
  /** The COMMITTED search. The bar never mutates it; only Apply writes back. */
  value: JobSearchDraft;
  onApply: (next: JobSearchDraft) => void;
  /** Opens an advanced settings surface, when the caller has one. */
  onOpenSettings?: () => void;
  className?: string;
}

export function JobSearchFilterBar({ value, onApply, onOpenSettings, className }: JobSearchFilterBarProps) {
  const [draft, setDraft] = useState<JobSearchDraft>(value);
  const searchId = useId();
  const excludeId = useId();

  // Re-sync when the committed search changes underneath us (a Clear elsewhere, a restored URL).
  const committedKey = useMemo(() => JSON.stringify(value), [value]);
  useEffect(() => {
    setDraft(value);
  }, [committedKey]);

  const dirty = !sameJobSearch(draft, value);
  const activeCount = countDraftFilters(draft);

  function patchFilters(patch: Partial<OpportunityFilters>): void {
    setDraft((current) => ({ ...current, filters: { ...current.filters, ...patch } }));
  }

  function apply(): void {
    if (!dirty) {
      return;
    }
    onApply(draft);
  }

  function clear(): void {
    setDraft(emptyJobSearchDraft());
  }

  return (
    <form
      className={cn("rounded-card border border-ios-separator bg-ios-card p-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      aria-label="Job search filters"
    >
      {/* PRIMARY SEARCH ROW */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor={searchId + "-scope"}>
          Search scope
        </label>
        <select
          id={searchId + "-scope"}
          value={draft.scope}
          onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as SearchScope }))}
          className={cn(
            "h-11 shrink-0 rounded-control border border-ios-separator bg-ios-card px-3 text-[15px] text-black",
            "focus-visible:border-ios-blue",
            INLINE_FOCUS_RING,
          )}
        >
          {SEARCH_SCOPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={searchId}>
          Search by title or keyword
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ios-text-secondary" aria-hidden="true" />
          <Input
            id={searchId}
            value={draft.query}
            onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))}
            placeholder="Search by title or keyword..."
            className="pl-9"
            autoComplete="off"
          />
        </div>
      </div>

      {/* EXCLUSION ROW */}
      <div className="mt-2">
        <label className="sr-only" htmlFor={excludeId}>
          Exclude keywords
        </label>
        <Input
          id={excludeId}
          value={draft.exclude}
          onChange={(event) => setDraft((current) => ({ ...current, exclude: event.target.value }))}
          placeholder="Exclude keywords (Hide jobs mentioning...)"
          autoComplete="off"
        />
      </div>

      {/* FILTER PILLS + ACTION AREA */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {PILL_SPECS.map((spec) => {
            const reason = pillUnavailableReason(spec);

            if (reason !== null) {
              return (
                <Popover key={spec.id}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-disabled="true"
                      className={cn(PILL_BASE, "border-dashed border-ios-separator bg-ios-bg text-ios-text-secondary", INLINE_FOCUS_RING)}
                    >
                      <span>{spec.label}</span>
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent aria-label={spec.label + " is not available yet"}>
                    <p className="text-sm font-semibold text-black">{spec.label}</p>
                    <p className="mt-1 text-sm text-ios-text-secondary">{reason}</p>
                  </PopoverContent>
                </Popover>
              );
            }

            if (spec.field === "freshness") {
              return (
                <Popover key={spec.id}>
                  <PillTrigger label={spec.label} active={draft.filters.freshness !== null} count={draft.filters.freshness ? 1 : 0} />
                  <PopoverContent>
                    <OptionRow
                      label="Any time"
                      selected={draft.filters.freshness === null}
                      onClick={() => patchFilters({ freshness: null })}
                    />
                    {FRESHNESS_WINDOWS.map((window) => (
                      <OptionRow
                        key={window.value}
                        label={window.label}
                        selected={draft.filters.freshness === window.value}
                        onClick={() => patchFilters({ freshness: window.value })}
                      />
                    ))}
                  </PopoverContent>
                </Popover>
              );
            }

            if (spec.field === "work_mode") {
              const options = REMOTE_PREFERENCE_OPTIONS.filter((option) => option.value !== "any");

              return (
                <Popover key={spec.id}>
                  <PillTrigger
                    label={spec.label}
                    active={draft.filters.workModes.length > 0}
                    count={draft.filters.workModes.length}
                  />
                  <PopoverContent>
                    {options.map((option) => {
                      const selected = draft.filters.workModes.includes(option.value);
                      return (
                        <OptionRow
                          key={option.value}
                          label={option.label}
                          selected={selected}
                          onClick={() =>
                            patchFilters({
                              workModes: selected
                                ? draft.filters.workModes.filter((value) => value !== option.value)
                                : [...draft.filters.workModes, option.value],
                            })
                          }
                        />
                      );
                    })}
                    <p className="mt-2 border-t border-ios-separator pt-2 text-xs text-ios-text-secondary">
                      Only listings that state a work mode can match, so selecting one hides the silent ones.
                    </p>
                  </PopoverContent>
                </Popover>
              );
            }

            // company
            return (
              <Popover key={spec.id}>
                <PillTrigger
                  label={spec.label}
                  active={draft.filters.companies.length > 0}
                  count={draft.filters.companies.length}
                />
                <PopoverContent className="w-64">
                  <label className="text-xs font-semibold text-ios-text-secondary" htmlFor={spec.id + "-companies"}>
                    Add a company
                  </label>
                  <Input
                    id={spec.id + "-companies"}
                    className="mt-1 h-9"
                    placeholder="Company name, then Enter"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const added = parseListInput(event.currentTarget.value);
                      if (added.length === 0) return;
                      patchFilters({
                        companies: Array.from(new Set([...draft.filters.companies, ...added])),
                      });
                      event.currentTarget.value = "";
                    }}
                  />
                  {draft.filters.companies.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {draft.filters.companies.map((company) => (
                        <li key={company}>
                          <button
                            type="button"
                            onClick={() =>
                              patchFilters({ companies: draft.filters.companies.filter((value) => value !== company) })
                            }
                            className="inline-flex items-center gap-1 rounded-full bg-ios-bg px-2 py-1 text-xs text-black"
                          >
                            {company}
                            <X className="h-3 w-3" aria-hidden="true" />
                            <span className="sr-only">Remove {company}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </PopoverContent>
              </Popover>
            );
          })}
        </div>

        {/* ACTION AREA — the ONLY thing that emits */}
        <div className="flex items-center gap-2">
          {activeCount > 0 ? (
            <Button variant="ghost" size="sm" type="button" onClick={clear}>
              Clear
            </Button>
          ) : null}
          {onOpenSettings ? (
            <Button variant="secondary" size="icon" type="button" aria-label="Search settings" onClick={onOpenSettings}>
              <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="submit" disabled={!dirty}>
            Apply
            {activeCount > 0 ? <span className="sr-only"> {activeCount} active filters</span> : null}
          </Button>
        </div>
      </div>
    </form>
  );
}
