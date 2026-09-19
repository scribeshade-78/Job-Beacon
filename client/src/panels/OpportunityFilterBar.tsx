import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  APPLICATION_STATUS_FILTER_OPTIONS,
  FRESHNESS_WINDOWS,
  REMOTE_PREFERENCE_OPTIONS,
  SORT_FIELDS_BY_ID,
  TRUST_FILTER_OPTIONS,
  VACANCY_FILTERS,
  VACANCY_SORTS,
  isFilterAvailable,
  isSortAvailable,
  type FilterFieldId,
  type FilterFieldSpec,
  type SortId,
} from "../../../shared/opportunityQuery";
import {
  EMPTY_FILTERS,
  countActiveFilters,
  inheritedFilterLabels,
  type OpportunityFilters,
} from "../lib/opportunityQuery";
import { parseListInput, type CandidatePreferences } from "../lib/candidatePreferences";
import { cn } from "../lib/utils";

/**
 * Task I — the Opportunities filter bar: all 10 declared filters plus the 6
 * sorts, driven entirely by shared/opportunityQuery.ts.
 *
 * WHY IT IS A SEPARATE, CONTROLLED COMPONENT. The panel owns the query; this
 * owns what the candidate is asking for. It fetches nothing, so it cannot
 * disagree with the panel about what is loaded, and the unavailable-field
 * decisions come from the spec's own isFilterAvailable rather than a second list
 * kept here.
 *
 * THE RULE THAT SHAPES EVERY CONTROL. A preference is durable (what you want); a
 * filter is transient (what you are looking at now). They overlap on location,
 * work mode and salary, and the overlap is where a UI asks for the same thing
 * twice. The panel seeds its filter state from deriveFiltersFromPreferences, and
 * every control that still holds its derived value is marked "From your
 * preferences" — a label that is computed from the current filter state, so it
 * disappears the instant the candidate changes that control for this search.
 *
 * AN UNAVAILABLE CONTROL IS SHOWN, DISABLED, AND EXPLAINED. Omitting it would
 * hide a named product feature; leaving it active would be worse, because an
 * active-looking filter that silently returns everything is indistinguishable
 * from one that works. The reason is the spec's unavailableReason, rendered as
 * visible text rather than a title attribute — hover does not exist on touch,
 * and a reason nobody can read is the same as no reason.
 */

interface OpportunityFilterBarProps {
  filters: OpportunityFilters;
  onChange: (filters: OpportunityFilters) => void;
  sort: SortId;
  onSortChange: (sort: SortId) => void;
  preferences: CandidatePreferences | null;
}

/**
 * Which inherited-filter key belongs to which control.
 *
 * The keys are the OpportunityFilters field names inheritedFilterLabels returns
 * ("countries", "workModes", "minSalary"); location is one control over two
 * fields, which is why countries — not cities — is the key it watches. A control
 * absent from this map can never be inherited, and the marker is simply not
 * rendered for it.
 */
const INHERITED_FILTER_KEY: Partial<Record<FilterFieldId, string>> = {
  location: "countries",
  work_mode: "workModes",
  salary: "minSalary",
};

/**
 * REMOTE_PREFERENCE_OPTIONS minus 'any'.
 *
 * The filter's values are the stored remote_type vocabulary
 * (remote / hybrid / on_site). 'any' is preference-shaped: it means "I do not
 * mind", and applied as a filter it would emit remote_type IN ('any'), which
 * matches nothing at all. The filter's equivalent of 'any' is an empty
 * selection — which is also what deriveFiltersFromPreferences produces from it,
 * so the two agree by construction.
 */
const WORK_MODE_FILTER_OPTIONS = REMOTE_PREFERENCE_OPTIONS.filter((option) => option.value !== "any");

const SOURCE_PLACEHOLDER = "remotive, greenhouse, usajobs";

function pillClasses(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
    active
      ? "border-ios-blue bg-ios-blue/10 text-ios-blue"
      : "border-ios-separator bg-ios-card text-black hover:bg-ios-bg",
  );
}

const FilterPill = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }>(
  ({ active = false, className, children, ...props }, ref) => (
    <button ref={ref} type="button" className={cn(pillClasses(active), className)} {...props}>
      {children}
    </button>
  ),
);
FilterPill.displayName = "FilterPill";

/** One line of summary for a pill: the single value, or how many are selected. */
function summarize(values: readonly string[], format: (value: string) => string): string | null {
  if (values.length === 0) {
    return null;
  }
  if (values.length === 1) {
    return format(values[0]);
  }
  return `${values.length} selected`;
}

function InlineNote({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-snug text-ios-text-secondary">{children}</p>;
}

/**
 * A filter or sort the schema cannot back. Rendered rather than omitted, and
 * disabled rather than inert-but-clickable, with the spec's reason visible
 * underneath (see the file header for why it is not a title attribute).
 */
function UnavailableControl({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex max-w-sm flex-col gap-1">
      <button
        type="button"
        disabled
        aria-disabled="true"
        title={`${label} — not available yet. This control has no backing column, so it is disabled rather than misleading.`}
        className="inline-flex w-fit cursor-not-allowed items-center gap-1.5 rounded-full border border-dashed border-ios-separator bg-ios-bg px-3 py-1.5 text-xs font-medium text-ios-text-secondary"
      >
        {label}
        <Badge className="bg-ios-separator px-1.5 py-0 text-[10px] font-semibold text-ios-text-secondary">
          Coming soon
        </Badge>
      </button>
      <p className="text-[11px] leading-snug text-ios-text-secondary">{reason}</p>
    </div>
  );
}

function InheritedMarker() {
  return (
    <span className="inline-flex items-center rounded-full bg-ios-blue/10 px-2 py-0.5 text-[11px] font-medium text-ios-blue">
      From your preferences
    </span>
  );
}

function OptionRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "w-full rounded-control px-2 py-1.5 text-left text-sm transition-colors",
        selected ? "bg-ios-blue/10 font-medium text-ios-blue" : "text-black hover:bg-ios-bg",
      )}
    >
      {children}
    </button>
  );
}

function CheckboxRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm text-black hover:bg-ios-bg">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-ios-separator text-ios-blue focus-visible:outline-ios-blue"
      />
      {children}
    </label>
  );
}

/**
 * A comma-or-newline separated text field bound to a list filter.
 *
 * The raw text is local state and the parsed list is what is committed, because
 * parsing on every keystroke would round-trip "India, " back to "India" and make
 * a second entry impossible to type. The re-seed compares the PARSE of the draft
 * against the incoming value, so a change made elsewhere (Clear, or a fresh
 * derivation from the profile) updates the box while ordinary typing does not
 * fight the caret.
 */
function ListField({
  id,
  label,
  values,
  placeholder,
  multiline = false,
  onChange,
}: {
  id: string;
  label: string;
  values: readonly string[];
  placeholder: string;
  multiline?: boolean;
  onChange: (values: string[]) => void;
}) {
  const separator = multiline ? "\n" : ", ";
  const [draft, setDraft] = useState(() => values.join(separator));

  useEffect(() => {
    if (JSON.stringify(parseListInput(draft)) !== JSON.stringify(values)) {
      setDraft(values.join(separator));
    }
  }, [draft, values, separator]);

  const shared = {
    id,
    value: draft,
    placeholder,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value);
      onChange(parseListInput(event.target.value));
    },
  };

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-ios-text-secondary">
        {label}
      </Label>
      {multiline ? (
        <textarea
          {...shared}
          rows={3}
          className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2 text-sm text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue"
        />
      ) : (
        <Input {...shared} />
      )}
    </div>
  );
}

function FreshnessControl({
  value,
  onChange,
}: {
  value: OpportunityFilters["freshness"];
  onChange: (value: OpportunityFilters["freshness"]) => void;
}) {
  const selected = FRESHNESS_WINDOWS.find((window) => window.value === value);
  const summary = selected?.label ?? null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill active={value !== null} aria-label={`Freshness filter — ${summary ?? "any time"}`}>
          {summary === null ? "Freshness" : `Freshness · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent>
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Freshness</p>
        <OptionRow selected={value === null} onClick={() => onChange(null)}>
          Any time
        </OptionRow>
        {FRESHNESS_WINDOWS.map((window) => (
          <OptionRow key={window.value} selected={window.value === value} onClick={() => onChange(window.value)}>
            {window.label}
          </OptionRow>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function LocationControl({
  filters,
  onChange,
}: {
  filters: OpportunityFilters;
  onChange: (patch: Partial<OpportunityFilters>) => void;
}) {
  const summary = summarize([...filters.countries, ...filters.cities], (value) => value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill
          active={filters.countries.length > 0 || filters.cities.length > 0}
          aria-label={`Location filter — ${summary ?? "none set"}`}
        >
          {summary === null ? "Location" : `Location · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Location</p>
        <div className="space-y-2 p-2">
          <ListField
            id="filter-countries"
            label="Countries"
            values={filters.countries}
            placeholder="India, Germany"
            onChange={(countries) => onChange({ countries })}
          />
          <ListField
            id="filter-cities"
            label="Cities"
            values={filters.cities}
            placeholder="Bengaluru, Berlin"
            onChange={(cities) => onChange({ cities })}
          />
          <InlineNote>Comma or new line between entries. Both lists must match, so a country and a city from different countries returns nothing.</InlineNote>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WorkModeControl({
  selected,
  onChange,
}: {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  const summary = summarize(selected, (value) =>
    WORK_MODE_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? value,
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill active={selected.length > 0} aria-label={`Work mode filter — ${summary ?? "none selected"}`}>
          {summary === null ? "Work mode" : `Work mode · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent>
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Work mode</p>
        {WORK_MODE_FILTER_OPTIONS.map((option) => (
          <CheckboxRow
            key={option.value}
            checked={selected.includes(option.value)}
            onChange={(checked) =>
              onChange(
                checked
                  ? [...selected.filter((value) => value !== option.value), option.value]
                  : selected.filter((value) => value !== option.value),
              )
            }
          >
            {option.label}
          </CheckboxRow>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function SalaryControl({
  minSalary,
  currency,
  onChange,
}: {
  minSalary: number | null;
  currency: string | null;
  onChange: (patch: Partial<OpportunityFilters>) => void;
}) {
  const [amount, setAmount] = useState(minSalary === null ? "" : String(minSalary));
  const [code, setCode] = useState(currency ?? "");

  // Re-seeded only when the incoming value disagrees with what is typed, so a
  // partial entry ("8", "80000.") survives its own round trip while a Clear or a
  // preference-derived reset still updates the boxes.
  useEffect(() => {
    const parsed = amount.trim() === "" ? null : Number(amount);
    if (parsed !== minSalary) {
      setAmount(minSalary === null ? "" : String(minSalary));
    }
  }, [amount, minSalary]);

  useEffect(() => {
    if ((code.trim().toUpperCase() || null) !== currency) {
      setCode(currency ?? "");
    }
  }, [code, currency]);

  const summary = minSalary === null ? null : `${currency ?? "any currency"} ${minSalary.toLocaleString("en-GB")}+`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill active={minSalary !== null} aria-label={`Salary filter — ${summary ?? "no floor set"}`}>
          {summary === null ? "Salary" : `Salary · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Minimum salary</p>
        <div className="space-y-2 p-2">
          <div className="space-y-1">
            <Label htmlFor="filter-min-salary" className="text-xs text-ios-text-secondary">
              Floor
            </Label>
            <Input
              id="filter-min-salary"
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="80000"
              value={amount}
              onChange={(event) => {
                const raw = event.target.value;
                setAmount(raw);
                const parsed = raw.trim() === "" ? null : Number(raw);
                onChange({ minSalary: parsed !== null && Number.isFinite(parsed) ? parsed : null });
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-min-salary-currency" className="text-xs text-ios-text-secondary">
              Currency
            </Label>
            <Input
              id="filter-min-salary-currency"
              maxLength={3}
              placeholder="Any"
              value={code}
              onChange={(event) => {
                const raw = event.target.value;
                setCode(raw);
                const trimmed = raw.trim().toUpperCase();
                onChange({ minSalaryCurrency: trimmed === "" ? null : trimmed });
              }}
            />
          </div>
          <InlineNote>Leave the currency empty to compare numbers in any currency.</InlineNote>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CompanyControl({
  values,
  onChange,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const summary = summarize(values, (value) => value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill active={values.length > 0} aria-label={`Company filter — ${summary ?? "none set"}`}>
          {summary === null ? "Company" : `Company · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Companies</p>
        <div className="space-y-2 p-2">
          <ListField
            id="filter-companies"
            label="Show only these companies"
            values={values}
            placeholder="Acme Corp"
            multiline
            onChange={onChange}
          />
          {/* Deliberately NOT seeded from the profile's excluded companies: an
              exclusion is a standing constraint, and presenting "companies I
              never want to see" as "companies I am searching for" is the
              opposite of what the candidate said. */}
          <InlineNote>Names must match the listing's company name.</InlineNote>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TrustControl({
  selected,
  onChange,
}: {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  const summary = summarize(selected, (value) =>
    TRUST_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? value,
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill active={selected.length > 0} aria-label={`Trust filter — ${summary ?? "none selected"}`}>
          {summary === null ? "Trust" : `Trust · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent>
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Trust status</p>
        {TRUST_FILTER_OPTIONS.map((option) => (
          <CheckboxRow
            key={option.value}
            checked={selected.includes(option.value)}
            onChange={(checked) =>
              onChange(
                checked
                  ? [...selected.filter((value) => value !== option.value), option.value]
                  : selected.filter((value) => value !== option.value),
              )
            }
          >
            {option.label}
          </CheckboxRow>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ApplicationStatusControl({
  selected,
  onChange,
}: {
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  const summary = summarize(selected, (value) =>
    APPLICATION_STATUS_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? value,
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill
          active={selected.length > 0}
          aria-label={`Application status filter — ${summary ?? "none selected"}`}
        >
          {summary === null ? "Application status" : `Application status · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent>
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Application status</p>
        {APPLICATION_STATUS_FILTER_OPTIONS.map((option) => (
          <CheckboxRow
            key={option.value}
            checked={selected.includes(option.value)}
            onChange={(checked) =>
              onChange(
                checked
                  ? [...selected.filter((value) => value !== option.value), option.value]
                  : selected.filter((value) => value !== option.value),
              )
            }
          >
            {option.label}
          </CheckboxRow>
        ))}
        <div className="px-2 pt-1">
          <InlineNote>Not applied means no application attempt exists for that vacancy yet.</InlineNote>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SourceControl({
  values,
  onChange,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const summary = summarize(values, (value) => value);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterPill active={values.length > 0} aria-label={`Source filter — ${summary ?? "none set"}`}>
          {summary === null ? "Source" : `Source · ${summary}`}
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </FilterPill>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Source</p>
        <div className="space-y-2 p-2">
          <ListField
            id="filter-sources"
            label="Source codes"
            values={values}
            placeholder={SOURCE_PLACEHOLDER}
            onChange={onChange}
          />
          <InlineNote>Free text, matched against the listing's source code.</InlineNote>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The sort selector.
 *
 * Same treatment as the filters: the spec decides what is offered and every
 * unavailable option is disabled with its reason visible in the list — in the
 * open list rather than behind a hover, which is why the reason is a paragraph
 * and not a title attribute.
 */
function SortControl({ sort, onSortChange }: { sort: SortId; onSortChange: (sort: SortId) => void }) {
  const selected = SORT_FIELDS_BY_ID[sort];

  return (
    <div className="flex max-w-md flex-col gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <FilterPill aria-label={`Sort order — ${selected.label}`}>
            {selected.orderBy.length === 0 ? "Sort" : `Sort · ${selected.label}`}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </FilterPill>
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <p className="px-2 py-1 text-xs font-semibold text-ios-text-secondary">Sort by</p>
          {VACANCY_SORTS.map((spec) =>
            isSortAvailable(spec.id) ? (
              <OptionRow key={spec.id} selected={spec.id === sort} onClick={() => onSortChange(spec.id)}>
                {spec.label}
              </OptionRow>
            ) : (
              <div key={spec.id} className="space-y-0.5 px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title={`${spec.label} — not available yet. This sort has no backing column, so it is disabled rather than misleading.`}
                    className="cursor-not-allowed text-left text-sm text-ios-text-secondary"
                  >
                    {spec.label}
                  </button>
                  <Badge className="bg-ios-separator px-1.5 py-0 text-[10px] font-semibold text-ios-text-secondary">
                    Coming soon
                  </Badge>
                </div>
                <p className="text-[11px] leading-snug text-ios-text-secondary">{spec.unavailableReason}</p>
              </div>
            ),
          )}
        </PopoverContent>
      </Popover>
      {selected.caveat !== null && <InlineNote>{selected.caveat}</InlineNote>}
    </div>
  );
}

function FilterControl({
  spec,
  filters,
  onChange,
  inherited,
}: {
  spec: FilterFieldSpec;
  filters: OpportunityFilters;
  onChange: (patch: Partial<OpportunityFilters>) => void;
  inherited: boolean;
}) {
  if (!isFilterAvailable(spec.id)) {
    return <UnavailableControl label={spec.label} reason={spec.unavailableReason ?? ""} />;
  }

  const control = renderControl(spec.id, filters, onChange);

  return (
    <div className="flex max-w-md flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {control}
        {inherited && <InheritedMarker />}
      </div>
      {/* The caveat is surfaced, not buried: it is a limitation that survives
          even though the filter works, and a candidate who cannot see it would
          reasonably read the result as complete. */}
      {spec.caveat !== null && <InlineNote>{spec.caveat}</InlineNote>}
    </div>
  );
}

function renderControl(
  id: FilterFieldId,
  filters: OpportunityFilters,
  onChange: (patch: Partial<OpportunityFilters>) => void,
) {
  switch (id) {
    case "freshness":
      return <FreshnessControl value={filters.freshness} onChange={(freshness) => onChange({ freshness })} />;
    case "location":
      return <LocationControl filters={filters} onChange={onChange} />;
    case "work_mode":
      return <WorkModeControl selected={filters.workModes} onChange={(workModes) => onChange({ workModes })} />;
    case "salary":
      return (
        <SalaryControl
          minSalary={filters.minSalary}
          currency={filters.minSalaryCurrency}
          onChange={onChange}
        />
      );
    case "company":
      return <CompanyControl values={filters.companies} onChange={(companies) => onChange({ companies })} />;
    case "trust":
      return (
        <TrustControl
          selected={filters.trustStatuses}
          onChange={(trustStatuses) => onChange({ trustStatuses })}
        />
      );
    case "application_status":
      return (
        <ApplicationStatusControl
          selected={filters.applicationStatuses}
          onChange={(applicationStatuses) => onChange({ applicationStatuses })}
        />
      );
    case "source":
      return <SourceControl values={filters.sources} onChange={(sources) => onChange({ sources })} />;
    // Handled above, before this switch is reached: both have no backing column,
    // so neither has a control to render.
    case "employment_type":
    case "seniority":
      return null;
  }
}

export function OpportunityFilterBar({
  filters,
  onChange,
  sort,
  onSortChange,
  preferences,
}: OpportunityFilterBarProps) {
  const inherited = inheritedFilterLabels(filters, preferences);
  const activeCount = countActiveFilters(filters);

  function update(patch: Partial<OpportunityFilters>) {
    onChange({ ...filters, ...patch });
  }

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2">
      {VACANCY_FILTERS.map((spec) => {
        const inheritedKey = INHERITED_FILTER_KEY[spec.id];
        return (
          <FilterControl
            key={spec.id}
            spec={spec}
            filters={filters}
            onChange={update}
            inherited={inheritedKey !== undefined && inherited.includes(inheritedKey)}
          />
        );
      })}

      <SortControl sort={sort} onSortChange={onSortChange} />

      <div className="flex items-center gap-2 pl-1">
        {/* The count is of filters the candidate has actually narrowed, computed
            by the same function the query layer uses, so a filter that cannot
            narrow anything (the two unavailable ones) is never counted. */}
        <span className="text-xs text-ios-text-secondary">{activeCount} filters</span>
        <Button
          size="sm"
          variant="secondary"
          // Clear returns to NOTHING, not to the derived preferences: "clear"
          // means "show me everything", and re-seeding it from the profile would
          // make the button look broken for the candidates most likely to press
          // it.
          onClick={() => onChange({ ...EMPTY_FILTERS })}
          disabled={activeCount === 0}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
