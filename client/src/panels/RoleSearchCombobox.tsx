import { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_CATEGORIES, ROLE_TAXONOMY, type RoleTaxonomyEntry } from "../../../shared/roleTaxonomy";
import { Input } from "../components/ui/input";
import { roleMatchKindOf, searchRoles } from "../lib/roleTaxonomy";
import { cn } from "../lib/utils";

/**
 * The role search box, with an overlay list that opens on FOCUS.
 *
 * WHY AN OVERLAY RATHER THAN A LIST UNDERNEATH. A candidate who does not yet know what
 * to type gets nothing from a box that only answers once they have typed - the empty
 * input was the least useful state and the one they see first. Focusing now shows the
 * whole catalog, grouped by industry, so the first interaction is browsing rather than
 * guessing a keyword.
 *
 * IT IS POSITIONED ABSOLUTELY, so opening it moves nothing. A dropdown in normal flow
 * would push the selected-roles list down the page every time the candidate clicked the
 * input, which is the layout jump this avoids.
 *
 * KEYBOARD NAVIGATION IS THE POINT OF BUILDING THIS RATHER THAN USING A <select>:
 * ArrowUp/ArrowDown move an active option, Enter selects it, Escape closes. The keys are
 * handled ONLY while the list is open and are preventDefault'd, so ArrowDown mid-list
 * never scrolls the page and never reaches the four-step tablist above, which uses the
 * same keys when a TAB has focus.
 */

interface Option {
  kind: "header" | "role";
  label?: string;
  entry?: RoleTaxonomyEntry;
}

interface RoleSearchComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  onSelect: (entry: RoleTaxonomyEntry) => void;
  /** Already-chosen titles, shown as such rather than offered again. */
  selectedTitles: Set<string>;
  disabled?: boolean;
}

/** The catalog grouped by industry, in the declared category order. */
function browseOptions(): Option[] {
  const options: Option[] = [{ kind: "header", label: "POPULAR ROLES (SCROLL TO VIEW ALL)" }];

  for (const category of ROLE_CATEGORIES) {
    const entries = ROLE_TAXONOMY.filter((entry) => entry.category === category);
    if (entries.length === 0) {
      continue;
    }
    options.push({ kind: "header", label: category.toUpperCase() });
    for (const entry of entries) {
      options.push({ kind: "role", entry });
    }
  }

  return options;
}

function matchesOptions(query: string): Option[] {
  // searchRoles already implements the exact/alias/partial ranking the static list used,
  // so the overlay and the section below it cannot disagree about what matches.
  return searchRoles(query).map((entry) => ({ kind: "role", entry }));
}

export function RoleSearchCombobox({
  value,
  onValueChange,
  onSelect,
  selectedTitles,
  disabled = false,
}: RoleSearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const query = value.trim();

  const options = useMemo<Option[]>(
    () => (query === "" ? browseOptions() : matchesOptions(query)),
    [query],
  );

  const selectableIndexes = useMemo(
    () => options.map((option, index) => (option.kind === "role" ? index : -1)).filter((index) => index >= 0),
    [options],
  );

  // A new query resets the cursor: keeping an index across two different result sets
  // would highlight whichever row happened to land at the same position.
  useEffect(() => {
    setActiveIndex(selectableIndexes.length > 0 ? selectableIndexes[0] : -1);
  }, [selectableIndexes]);

  // Keep the active option in view. Without this, arrowing past the visible area leaves
  // the highlight somewhere the candidate cannot see.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = list.current?.querySelector('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  function move(delta: number) {
    if (selectableIndexes.length === 0) return;
    const current = selectableIndexes.indexOf(activeIndex);
    const next = current === -1 ? 0 : (current + delta + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[next]);
  }

  function choose(index: number) {
    const option = options[index];
    if (option?.kind !== "role" || !option.entry || option.entry === undefined) return;
    if (selectedTitles.has(option.entry.title)) return;
    onSelect(option.entry);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // preventDefault even when closed: ArrowDown inside a text input would otherwise
      // move the caret to the end, and the page could scroll.
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex);
    }
  }

  return (
    <div
      className="relative"
      ref={wrapper}
      onBlur={(event) => {
        // relatedTarget is where focus is GOING. Closing only when focus leaves the whole
        // widget is what lets a click on an option land before the list disappears -
        // the classic blur-before-click bug, avoided without a setTimeout.
        if (!wrapper.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <Input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Search by title, e.g. engineer"
        aria-label="Search target roles"
        aria-expanded={open}
        aria-controls="role-search-listbox"
        aria-autocomplete="list"
        role="combobox"
        autoComplete="off"
        disabled={disabled}
      />

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-control border border-ios-separator bg-white shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-ios-text-secondary">
              No role matches "{query}". You can still save it as a custom role below.
            </p>
          ) : (
            <ul
              id="role-search-listbox"
              ref={list}
              role="listbox"
              aria-label="Roles"
              className="max-h-72 overflow-y-auto py-1"
            >
              {options.map((option, index) =>
                option.kind === "header" ? (
                  <li
                    key={"header-" + option.label}
                    role="presentation"
                    className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-ios-text-secondary"
                  >
                    {option.label}
                  </li>
                ) : (
                  (() => {
                    const entry = option.entry as RoleTaxonomyEntry;
                    const already = selectedTitles.has(entry.title);
                    const active = index === activeIndex;
                    const kind = query === "" ? null : roleMatchKindOf(entry, query);

                    return (
                      <li
                        key={entry.id}
                        role="option"
                        aria-selected={active}
                        aria-disabled={already}
                        data-active={active}
                        // onMouseDown preventDefault keeps focus in the input so the
                        // wrapper's blur handler never fires for a click inside the list.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(index)}
                        className={cn(
                          "flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm",
                          active ? "bg-ios-blue/10" : "bg-transparent",
                          already ? "cursor-default opacity-60" : "",
                        )}
                      >
                        <span className="min-w-0 truncate">
                          {entry.title}
                          <span className="text-ios-text-secondary"> · {entry.category}</span>
                          {kind === "partial" ? (
                            <span className="ml-2 text-xs text-ios-text-secondary">Partial match</span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-xs text-ios-text-secondary">
                          {already ? "Added" : "Add"}
                        </span>
                      </li>
                    );
                  })()
                ),
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
