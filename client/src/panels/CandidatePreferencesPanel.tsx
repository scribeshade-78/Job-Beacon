import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { showToast } from "../components/ui/use-toast";
import { listSelectedRoles } from "../lib/candidateSelectedRoles";
import {
  loadCandidatePreferences,
  parseListInput,
  saveCandidatePreferences,
  type CandidatePreferences,
} from "../lib/candidatePreferences";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import {
  EMPLOYMENT_TYPE_OPTIONS,
  FILTER_FIELDS_BY_ID,
  PREFERENCE_EXCLUSIONS,
  REMOTE_PREFERENCE_OPTIONS,
  WORK_AUTHORIZATION_OPTIONS,
  type EmploymentTypeValue,
  type RemotePreferenceValue,
  type WorkAuthorizationValue,
} from "../../../shared/opportunityQuery";

/**
 * Task I — the candidate's durable preferences, edited in one place.
 *
 * WHY THIS EXISTS AT ALL. A preference is what the candidate wants; a filter is
 * what they are looking at right now. The two overlap on location, work mode and
 * salary, and the overlap is where a naive design asks for the same thing twice.
 * The Opportunities bar therefore SEEDS its filters from these values and labels
 * the controls it filled "from your preferences", so this panel is where the
 * candidate states them once.
 *
 * WHY TARGET ROLES IS NOT AN INPUT HERE. Roles already live in
 * candidate_selected_roles, with their own table, their own panel and a
 * taxonomy-driven search (TargetRolesPanel). candidate_preferences has no roles
 * column, so an input bound to this panel's save would either write that other
 * table behind the candidate's back or create a second store for the same fact —
 * two places that can disagree about what the candidate is looking for. The
 * panel reports the count read from the table that owns it and links to the page
 * that edits it.
 *
 * EVERY FIELD IS NULLABLE AND NULL MEANS "NOT STATED", which is deliberately not
 * the same as a negative answer: "I have not said whether I will relocate" and
 * "I will not relocate" lead to different matching behaviour. That is why the
 * two booleans here are tri-state rather than switches.
 */

interface CandidatePreferencesPanelProps {
  candidateId: string;
}

/** The value a radio group uses for "not stated", so null survives the round trip. */
const UNSET_VALUE = "unset";

const DEFAULT_CURRENCY = "USD";

const EMPLOYMENT_TYPE_NOTE = FILTER_FIELDS_BY_ID.employment_type.unavailableReason;

const EXCLUDED_COMPANIES = PREFERENCE_EXCLUSIONS.find((entry) => entry.id === "excluded_companies");
const EXCLUDED_INDUSTRIES = PREFERENCE_EXCLUSIONS.find((entry) => entry.id === "excluded_industries");

/**
 * The form's own state, which is TEXT where the stored value is a list.
 *
 * Parsing on every keystroke would make "India, " impossible to type — the
 * trailing separator would round-trip away — so the raw text is kept here and
 * split once, on save, with the same parseListInput the exclusions fields use.
 */
interface PreferencesDraft {
  countries: string;
  cities: string;
  remotePreference: RemotePreferenceValue | null;
  employmentTypes: EmploymentTypeValue[];
  workAuthorization: WorkAuthorizationValue | null;
  requiresSponsorship: boolean | null;
  minSalary: string;
  minSalaryCurrency: string;
  willingToRelocate: boolean | null;
  excludedCompanies: string;
  excludedIndustries: string;
}

function toDraft(preferences: CandidatePreferences | null): PreferencesDraft {
  return {
    countries: (preferences?.preferredCountries ?? []).join(", "),
    cities: (preferences?.preferredCities ?? []).join(", "),
    remotePreference: preferences?.remotePreference ?? null,
    employmentTypes: preferences?.employmentTypes ?? [],
    workAuthorization: preferences?.workAuthorization ?? null,
    requiresSponsorship: preferences?.requiresSponsorship ?? null,
    minSalary: preferences?.minSalary === null || preferences?.minSalary === undefined
      ? ""
      : String(preferences.minSalary),
    // Defaulted rather than blank: a salary floor with no unit is not a floor,
    // and showing the currency that will actually be saved beats an empty box
    // that only fails once the candidate presses Save.
    minSalaryCurrency: preferences?.minSalaryCurrency ?? DEFAULT_CURRENCY,
    willingToRelocate: preferences?.willingToRelocate ?? null,
    excludedCompanies: (preferences?.excludedCompanies ?? []).join("\n"),
    excludedIndustries: (preferences?.excludedIndustries ?? []).join("\n"),
  };
}

function toggleValue<T>(values: readonly T[], value: T, checked: boolean): T[] {
  return checked
    ? [...values.filter((entry) => entry !== value), value]
    : values.filter((entry) => entry !== value);
}

interface RadioChoice {
  value: string;
  label: string;
}

const REMOTE_PREFERENCE_CHOICES: RadioChoice[] = [
  { value: UNSET_VALUE, label: "Not stated" },
  ...REMOTE_PREFERENCE_OPTIONS.map((option) => ({ value: option.value as string, label: option.label })),
];

interface TriStateFieldProps {
  id: string;
  legend: string;
  value: boolean | null;
  unsetLabel: string;
  yesLabel: string;
  noLabel: string;
  disabled: boolean;
  onChange: (value: boolean | null) => void;
}

/**
 * A yes/no that can also be unanswered.
 *
 * A Switch cannot express three states, and forcing an unanswered question into
 * false would state a preference the candidate never gave — so this is a radio
 * group whose third option is the honest one.
 */
function TriStateField({
  id,
  legend,
  value,
  unsetLabel,
  yesLabel,
  noLabel,
  disabled,
  onChange,
}: TriStateFieldProps) {
  const choices: RadioChoice[] = [
    { value: UNSET_VALUE, label: unsetLabel },
    { value: "yes", label: yesLabel },
    { value: "no", label: noLabel },
  ];

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-black">{legend}</legend>
      <RadioGroup
        aria-label={legend}
        value={value === null ? UNSET_VALUE : value ? "yes" : "no"}
        onValueChange={(next) => onChange(next === UNSET_VALUE ? null : next === "yes")}
        disabled={disabled}
      >
        {choices.map((choice) => (
          <div key={choice.value} className="flex items-center gap-2.5">
            <RadioGroupItem value={choice.value} id={`${id}-${choice.value}`} />
            <Label htmlFor={`${id}-${choice.value}`} className="font-normal">
              {choice.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

export function CandidatePreferencesPanel({ candidateId }: CandidatePreferencesPanelProps) {
  const [draft, setDraft] = useState<PreferencesDraft>(() => toDraft(null));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleCount, setRoleCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadCandidatePreferences(getSupabaseBrowserClient(), candidateId).then((result) => {
      if (cancelled) return;

      setLoaded(true);

      if (result.kind === "success") {
        setDraft(toDraft(result.preferences));
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [candidateId]);

  /**
   * The target-role count, read from the table that owns roles rather than from
   * anything this panel saves. A failure here leaves the line saying only that
   * roles are managed elsewhere, which is still true.
   */
  useEffect(() => {
    let cancelled = false;

    listSelectedRoles(getSupabaseBrowserClient()).then((result) => {
      if (cancelled || result.kind !== "success") return;
      setRoleCount(result.roles.length);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  function patch(next: Partial<PreferencesDraft>) {
    setDraft((previous) => ({ ...previous, ...next }));
  }

  async function handleSave() {
    const minSalary = draft.minSalary.trim() === "" ? null : Number(draft.minSalary);

    if (minSalary !== null && !Number.isFinite(minSalary)) {
      const message = "Enter your minimum salary as a number.";
      setError(message);
      showToast({ title: message, tone: "error" });
      return;
    }

    setError(null);
    setSaving(true);

    const result = await saveCandidatePreferences(getSupabaseBrowserClient(), candidateId, {
      preferredCountries: parseListInput(draft.countries),
      preferredCities: parseListInput(draft.cities),
      remotePreference: draft.remotePreference,
      employmentTypes: draft.employmentTypes,
      workAuthorization: draft.workAuthorization,
      requiresSponsorship: draft.requiresSponsorship,
      minSalary,
      minSalaryCurrency: draft.minSalaryCurrency.trim() === "" ? null : draft.minSalaryCurrency,
      willingToRelocate: draft.willingToRelocate,
      excludedCompanies: parseListInput(draft.excludedCompanies),
      excludedIndustries: parseListInput(draft.excludedIndustries),
    });

    setSaving(false);

    if (result.kind === "error") {
      // Includes the library's own refusal of a salary floor with no currency —
      // shown as returned rather than reworded, so the reason the candidate sees
      // is the reason the save was rejected.
      setError(result.message);
      showToast({ title: result.message, tone: "error" });
      return;
    }

    // Re-seeded from the SAVED row rather than kept as typed: what is on screen
    // after a save is what the database holds, uppercased currency included.
    setDraft(toDraft(result.preferences));
    showToast({ title: "Preferences saved.", tone: "success" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="candidate-preferences-title">Job Preferences</CardTitle>
        <CardDescription>
          What you are looking for. These seed your searches and apply as standing exclusions, so you
          are not asked for the same thing in the Opportunities filters.
        </CardDescription>
      </CardHeader>
      <CardContent aria-labelledby="candidate-preferences-title" className="space-y-6">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}

        {/* 1. Target Roles — read-only, because the input for it already exists
            on its own page and a second one could disagree with the first. */}
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium text-black">Target Roles</h3>
          <p className="text-sm text-ios-text-secondary">
            {roleCount === null
              ? "Loading your target roles…"
              : roleCount === 0
                ? "No target roles selected yet."
                : `${roleCount} ${roleCount === 1 ? "role" : "roles"} selected.`}{" "}
            Roles are managed on the Target Roles page, not here — this panel only shows how many you
            have.
          </p>
          <Link href="/target-roles" className="text-sm text-ios-blue hover:underline">
            Manage target roles
          </Link>
        </section>

        {/* 2. Location / Remote preference */}
        <section className="space-y-3 border-t border-ios-separator pt-5">
          <h3 className="text-sm font-medium text-black">Location and remote preference</h3>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="preferred-countries" className="text-xs text-ios-text-secondary">
                Countries
              </Label>
              <Input
                id="preferred-countries"
                value={draft.countries}
                placeholder="India, Germany"
                disabled={!loaded}
                onChange={(event) => patch({ countries: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="preferred-cities" className="text-xs text-ios-text-secondary">
                Cities
              </Label>
              <Input
                id="preferred-cities"
                value={draft.cities}
                placeholder="Bengaluru, Berlin"
                disabled={!loaded}
                onChange={(event) => patch({ cities: event.target.value })}
              />
            </div>
          </div>

          <p className="text-xs text-ios-text-secondary">
            Separate entries with a comma or a new line. These are the starting values of the country
            and city filters in Opportunities.
          </p>

          <RadioGroup
            aria-label="Remote preference"
            value={draft.remotePreference ?? UNSET_VALUE}
            disabled={!loaded}
            onValueChange={(next) =>
              patch({
                remotePreference: next === UNSET_VALUE ? null : (next as RemotePreferenceValue),
              })
            }
          >
            {REMOTE_PREFERENCE_CHOICES.map((choice) => (
              <div key={choice.value} className="flex items-center gap-2.5">
                <RadioGroupItem value={choice.value} id={`remote-preference-${choice.value}`} />
                <Label htmlFor={`remote-preference-${choice.value}`} className="font-normal">
                  {choice.label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </section>

        {/* 3. Employment type — saved, but not applied to results yet. */}
        <section className="space-y-2 border-t border-ios-separator pt-5">
          <h3 className="text-sm font-medium text-black">Employment type</h3>

          <div className="grid gap-2 sm:grid-cols-2">
            {EMPLOYMENT_TYPE_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm text-black">
                {/* Native checkbox, the same treatment ExclusionsPanel uses, so
                    the app's multi-select surfaces match. Deliberately NOT
                    disabled: the preference is stored, it simply does not filter
                    anything yet, and disabling the input would imply the choice
                    itself was unavailable. */}
                <input
                  type="checkbox"
                  checked={draft.employmentTypes.includes(option.value)}
                  disabled={!loaded}
                  onChange={(event) =>
                    patch({
                      employmentTypes: toggleValue(
                        draft.employmentTypes,
                        option.value,
                        event.target.checked,
                      ),
                    })
                  }
                  className="h-4 w-4 rounded border-ios-separator text-ios-blue-button focus-visible:outline-ios-blue"
                />
                {option.label}
              </label>
            ))}
          </div>

          {/* The filter spec's own unavailableReason, not a second copy of it, so
              this note and the disabled filter in the Opportunities bar cannot
              drift apart. */}
          <p className="text-xs text-ios-text-secondary">{EMPLOYMENT_TYPE_NOTE}</p>
        </section>

        {/* 4. Work authorization / sponsorship */}
        <section className="space-y-3 border-t border-ios-separator pt-5">
          <h3 className="text-sm font-medium text-black">Work authorization and sponsorship</h3>

          <div className="space-y-1.5">
            <Label htmlFor="work-authorization" className="text-xs text-ios-text-secondary">
              Work authorization
            </Label>
            {/* A select rather than five radios: this is an enumeration the
                candidate scans once, not a value they toggle repeatedly, and the
                panel already carries two tri-state radio groups. */}
            <select
              id="work-authorization"
              value={draft.workAuthorization ?? UNSET_VALUE}
              disabled={!loaded}
              onChange={(event) =>
                patch({
                  workAuthorization:
                    event.target.value === UNSET_VALUE
                      ? null
                      : (event.target.value as WorkAuthorizationValue),
                })
              }
              className="h-11 w-full max-w-sm rounded-control border border-ios-separator bg-ios-card px-3.5 text-[15px] text-black focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value={UNSET_VALUE}>Not stated</option>
              {WORK_AUTHORIZATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <TriStateField
            id="requires-sponsorship"
            legend="Requires visa sponsorship"
            value={draft.requiresSponsorship}
            unsetLabel="Not stated"
            yesLabel="Yes — I need sponsorship"
            noLabel="No — I do not need sponsorship"
            disabled={!loaded}
            onChange={(value) => patch({ requiresSponsorship: value })}
          />

          {/* Said plainly rather than left to look like a working setting:
              vacancies carry no authorization or sponsorship data, so nothing
              matches against this today. */}
          <p className="text-xs text-ios-text-secondary">
            Recorded on your profile. Vacancies carry no work-authorization or sponsorship data, so
            this is not applied to your results yet.
          </p>
        </section>

        {/* 5. Minimum salary */}
        <section className="space-y-2 border-t border-ios-separator pt-5">
          <h3 className="text-sm font-medium text-black">Minimum salary</h3>

          <div className="flex flex-wrap gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="min-salary" className="text-xs text-ios-text-secondary">
                Amount
              </Label>
              <Input
                id="min-salary"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="80000"
                value={draft.minSalary}
                disabled={!loaded}
                onChange={(event) => patch({ minSalary: event.target.value })}
                className="w-32"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="min-salary-currency" className="text-xs text-ios-text-secondary">
                Currency
              </Label>
              <Input
                id="min-salary-currency"
                maxLength={3}
                placeholder={DEFAULT_CURRENCY}
                value={draft.minSalaryCurrency}
                disabled={!loaded}
                onChange={(event) => patch({ minSalaryCurrency: event.target.value.toUpperCase() })}
                className="w-24"
              />
            </div>
          </div>

          <p className="text-xs text-ios-text-secondary">
            A salary floor with no currency is not a floor — 80000 means different things in INR and
            USD — so the currency is required and starts at USD. This is the starting value of the
            salary filter in Opportunities.
          </p>
        </section>

        {/* 6. Relocation */}
        <section className="border-t border-ios-separator pt-5">
          <TriStateField
            id="willing-to-relocate"
            legend="Willing to relocate"
            value={draft.willingToRelocate}
            unsetLabel="Not stated"
            yesLabel="Yes"
            noLabel="No"
            disabled={!loaded}
            onChange={(value) => patch({ willingToRelocate: value })}
          />
        </section>

        {/* 7. Excluded companies */}
        <section className="space-y-1.5 border-t border-ios-separator pt-5">
          <Label htmlFor="excluded-companies" className="text-sm font-medium text-black">
            {EXCLUDED_COMPANIES?.label ?? "Excluded companies"}
          </Label>
          <textarea
            id="excluded-companies"
            rows={3}
            placeholder="Acme Corp, Globex"
            value={draft.excludedCompanies}
            disabled={!loaded}
            onChange={(event) => patch({ excludedCompanies: event.target.value })}
            className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
          />
          {/* Standing exclusion, not a filter: it applies to every search with no
              control in the filter bar, because the candidate already said it
              once and a second input for the same thing is the clutter Task I
              removes. */}
          <p className="text-xs text-ios-text-secondary">
            One per line, or separated by commas. Applied to every search: listings whose{" "}
            {EXCLUDED_COMPANIES?.column ?? "company_name"} matches one of these are hidden.
          </p>
        </section>

        {/* 8. Excluded industries */}
        <section className="space-y-1.5 border-t border-ios-separator pt-5">
          <Label htmlFor="excluded-industries" className="text-sm font-medium text-black">
            {EXCLUDED_INDUSTRIES?.label ?? "Excluded industries"}
          </Label>
          <textarea
            id="excluded-industries"
            rows={3}
            placeholder="Gambling, Tobacco"
            value={draft.excludedIndustries}
            disabled={!loaded}
            onChange={(event) => patch({ excludedIndustries: event.target.value })}
            className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
          />
          {/* Stored but not applied, and said so. The column named here comes
              from PREFERENCE_EXCLUSIONS rather than being retyped, and the reason
              is the one the query layer gives when it reports this exclusion as
              unapplied: the view exposes no industry, so there is nothing to
              match against. */}
          <p className="text-xs text-ios-text-secondary">
            Saved to your profile, but not applied to your results yet: the opportunities view
            exposes no {EXCLUDED_INDUSTRIES?.column ?? "company_industry"} column, so there is
            nothing to match these against.
          </p>
        </section>

        <div className="flex items-center justify-end gap-3 border-t border-ios-separator pt-5">
          <Button onClick={() => void handleSave()} disabled={!loaded || saving} aria-busy={saving}>
            {saving ? "Saving…" : "Save preferences"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
