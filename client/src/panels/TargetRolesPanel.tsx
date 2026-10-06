import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  listSelectedRoles,
  removeRole,
  replaceRoleIntent,
  selectRole,
  type SelectedRole,
} from "../lib/candidateSelectedRoles";
import { listExtractedFacts, type ExtractedFact } from "../lib/resumeExtraction";
import { suggestRoles, type SuggestionTier } from "../lib/roleSuggestions";
import { relatedRoles, roleMatchKindOf, searchRoles } from "../lib/roleTaxonomy";
import { qualifierPreferenceLabel, preferredQualifiers } from "../../../shared/candidateQualifiers";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";
import { describeRankingRefresh, runRankingRefresh } from "../lib/feedRankingRefresh";

interface TargetRolesPanelProps {
  candidateId: string;
}

const TIER_LABELS: Record<SuggestionTier, string> = {
  primary: "Primary matches",
  strong: "Strong matches",
  related: "Related roles",
};

const NOT_RECORDED = "Preference not recorded";

/**
 * The ranking refresh is reported SEPARATELY from the role save. A save that
 * succeeded is a success even if the derived refresh afterwards fails, so the two
 * never share an error slot.
 */
type RankingRefreshState =
  | { kind: "idle" }
  | { kind: "running"; text: string }
  | { kind: "done"; text: string }
  | { kind: "failed"; text: string; retryable: boolean };

/** How a saved selection's recorded intent reads. NULL is "not recorded", never inferred. */
function describeIntent(role: SelectedRole): string {
  const qualifiers = preferredQualifiers(role.rawRoleName, role.roleName);

  if (role.rawRoleName === null) {
    return NOT_RECORDED;
  }

  const label = qualifierPreferenceLabel(qualifiers);
  return label === null ? 'Asked for "' + role.rawRoleName + '"' : 'Asked for "' + role.rawRoleName + '" · ' + label;
}

export function TargetRolesPanel({ candidateId }: TargetRolesPanelProps) {
  const [selectedRoles, setSelectedRoles] = useState<SelectedRole[] | null>(null);
  const [facts, setFacts] = useState<ExtractedFact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [rankingRefresh, setRankingRefresh] = useState<RankingRefreshState>({ kind: "idle" });
  const refreshAbort = useRef<AbortController | null>(null);

  /**
   * Fires the REAL refresh path (an authenticated server call), then polls it to
   * completion. It is deliberately independent of the save: the save result is
   * already reported, and this only adds a ranking status beside it. Polling stops
   * on completion, on the local cap, or when the panel unmounts (the abort signal).
   */
  const startRankingRefresh = useCallback((force: boolean) => {
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;

    setRankingRefresh({ kind: "running", text: "Your preference is saved. Updating your ranking…" });

    void runRankingRefresh({
      force,
      signal: controller.signal,
      onUpdate: (result) => {
        if (!controller.signal.aborted && result.outcome === "running") {
          setRankingRefresh({ kind: "running", text: describeRankingRefresh(result) });
        }
      },
    })
      .then((run) => {
        if (controller.signal.aborted) return;

        if (run.kind === "done") {
          if (run.result.outcome === "failed") {
            setRankingRefresh({
              kind: "failed",
              text: describeRankingRefresh(run.result),
              retryable: run.result.retryable,
            });
          } else {
            setRankingRefresh({ kind: "done", text: describeRankingRefresh(run.result) });
          }
          return;
        }

        if (run.kind === "timeout") {
          setRankingRefresh({ kind: "running", text: "Still updating your ranking…" });
          return;
        }

        setRankingRefresh({ kind: "failed", text: run.message, retryable: run.retryable });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRankingRefresh({ kind: "failed", text: "Could not update your ranking.", retryable: true });
        }
      });
  }, []);

  useEffect(() => () => refreshAbort.current?.abort(), []);

  async function refresh() {
    const client = getSupabaseBrowserClient();

    const [rolesResult, factsResult] = await Promise.all([listSelectedRoles(client), listExtractedFacts(client)]);

    if (rolesResult.kind === "success") {
      setSelectedRoles(rolesResult.roles);
    } else {
      setError(rolesResult.message);
    }

    if (factsResult.kind === "success") {
      setFacts(factsResult.facts);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTitles = useMemo(
    () => new Set((selectedRoles ?? []).map((role) => role.roleName)),
    [selectedRoles],
  );

  const suggestionsByTier = useMemo(() => {
    const grouped: Record<SuggestionTier, ReturnType<typeof suggestRoles>> = { primary: [], strong: [], related: [] };
    for (const suggestion of suggestRoles(facts)) {
      if (!selectedTitles.has(suggestion.entry.title)) {
        grouped[suggestion.tier].push(suggestion);
      }
    }
    return grouped;
  }, [facts, selectedTitles]);

  const trimmedQuery = searchQuery.trim();
  const rawSearchResults = useMemo(() => searchRoles(searchQuery), [searchQuery]);
  const searchResults = useMemo(
    () => rawSearchResults.filter((entry) => !selectedTitles.has(entry.title)),
    [rawSearchResults, selectedTitles],
  );

  /**
   * The phrase the candidate typed, when it says something the canonical role
   * does not. Offered for CONFIRMATION — never saved on its own, because a query
   * that returned several roles is not each role's intent.
   */
  /**
   * The TOP-RANKED result, not an "exact" one.
   *
   * "Azure Data Engineer" is deliberately a PARTIAL match against "Data
   * Engineer": the matcher ranks the closest occupation first and the extra word
   * is what the candidate wants on top of it. Requiring an exact match here made
   * the confirmation unreachable for precisely the case it exists for.
   */
  const topResult = rawSearchResults.length > 0 ? rawSearchResults[0] : null;

  const intentOffer = useMemo(() => {
    if (topResult === null || trimmedQuery === "") {
      return null;
    }

    const qualifiers = preferredQualifiers(trimmedQuery, topResult.title);

    if (qualifiers.length === 0) {
      return null;
    }

    return { entry: topResult, qualifiers, label: qualifierPreferenceLabel(qualifiers) };
  }, [topResult, trimmedQuery]);

  /** Related roles for the top result. Shown, never auto-selected. */
  const relatedForQuery = useMemo(
    () => (topResult === null ? [] : relatedRoles(topResult)),
    [topResult],
  );

  async function handleSelect(title: string, rawRoleName?: string, normalizedRoleId?: string) {
    setError(null);
    setNotice(null);

    // A DUPLICATE IS NOT A SAVE. The row already exists, and selectRole
    // deliberately leaves its recorded intent alone, so claiming the new phrase
    // was stored would be false. Show what IS recorded instead.
    const existing = (selectedRoles ?? []).find((role) => role.roleName === title);

    if (existing !== undefined) {
      setNotice(title + ' is already in your list. Saved intent: ' + describeIntent(existing) + ".");
      return;
    }

    setBusyKey(title);

    const result = await selectRole(getSupabaseBrowserClient(), candidateId, title, {
      rawRoleName: rawRoleName ?? null,
      normalizedRoleId: normalizedRoleId ?? null,
    });

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setSearchQuery("");
      await refresh();
      // The save SUCCEEDED. The ranking refresh is separate and never changes that.
      startRankingRefresh(true);
    }

    setBusyKey(null);
  }

  async function handleAddCustomRole() {
    const title = searchQuery.trim();
    if (title === "") return;

    setError(null);
    setNotice(null);
    setBusyKey(title);

    const result = await selectRole(getSupabaseBrowserClient(), candidateId, title);

    if (result.kind === "error") {
      // The query is deliberately NOT cleared: a failed save must not lose what
      // the candidate typed.
      setError(result.message);
    } else {
      setSearchQuery("");
      await refresh();
      // The save SUCCEEDED. The ranking refresh is separate and never changes that.
      startRankingRefresh(true);
    }

    setBusyKey(null);
  }

  async function handleSaveIntent(role: SelectedRole, rawRoleName: string) {
    setError(null);
    setNotice(null);
    setBusyKey(role.id);

    const result = await replaceRoleIntent(getSupabaseBrowserClient(), role.id, {
      rawRoleName,
      normalizedRoleId: role.normalizedRoleId,
    });

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setNotice(describeIntent({ ...role, rawRoleName: rawRoleName.trim() === "" ? null : rawRoleName.trim() }));
      setEditingId(null);
      await refresh();
      startRankingRefresh(true);
    }

    setBusyKey(null);
  }

  async function handleRemove(id: string) {
    setError(null);
    setNotice(null);
    setBusyKey(id);

    const result = await removeRole(getSupabaseBrowserClient(), id);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
      startRankingRefresh(true);
    }

    setBusyKey(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="target-roles-title">Target Roles</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="target-roles-title" className="space-y-6">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {notice !== null && (
          <p role="status" className="text-sm text-ios-text-secondary">
            {notice}
          </p>
        )}

        {/* SEPARATE FROM error/notice ON PURPOSE. A successful save is reported
            above even when this refresh fails; a refresh failure is its own,
            retryable condition and never reads as "your preference was not
            saved". */}
        {rankingRefresh.kind === "running" && (
          <p role="status" aria-live="polite" className="text-sm text-ios-text-secondary">
            {rankingRefresh.text}
          </p>
        )}
        {rankingRefresh.kind === "done" && (
          <p role="status" className="text-sm text-ios-text-secondary">
            {rankingRefresh.text}
          </p>
        )}
        {rankingRefresh.kind === "failed" && (
          <p role="status" className="text-sm text-status-blocked-fg">
            {rankingRefresh.text}{" "}
            {rankingRefresh.retryable && (
              <button
                type="button"
                onClick={() => startRankingRefresh(true)}
                className="font-medium text-ios-blue hover:underline"
              >
                Retry
              </button>
            )}
          </p>
        )}

        <section>
          <h3 className="text-sm font-semibold text-black">Selected roles</h3>
          {selectedRoles !== null && selectedRoles.length === 0 && (
            <p className="mt-2 text-sm text-ios-text-secondary">
              No target roles yet. Search below or pick a suggestion.
            </p>
          )}
          <ul className="mt-2 space-y-2">
            {selectedRoles?.map((role) => (
              <li
                key={role.id}
                className="rounded-control border border-ios-separator bg-ios-card p-2.5 text-sm text-black"
              >
                <div className="flex items-center justify-between gap-2">
                  <span>{role.roleName}</span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setEditingId(editingId === role.id ? null : role.id);
                        setEditValue(role.rawRoleName ?? "");
                      }}
                    >
                      Edit preference
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busyKey === role.id}
                      onClick={() => void handleRemove(role.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-ios-text-secondary">{describeIntent(role)}</p>

                {editingId === role.id && (
                  <div className="mt-2 space-y-2">
                    <Input
                      value={editValue}
                      onChange={(event) => setEditValue(event.target.value)}
                      aria-label={"Preferred phrase for " + role.roleName}
                      placeholder="e.g. Azure Data Engineer"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" disabled={busyKey === role.id} onClick={() => void handleSaveIntent(role, editValue)}>
                        Save preference
                      </Button>
                      <Button size="sm" variant="secondary" disabled={busyKey === role.id} onClick={() => void handleSaveIntent(role, "")}>
                        Clear preference
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-sm font-semibold text-black">Search roles</h3>
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by title, e.g. engineer"
            aria-label="Search target roles"
            className="mt-2"
          />

          {searchResults.length > 0 && (
            <ul className="mt-2 space-y-2">
              {searchResults.map((entry) => {
                const kind = roleMatchKindOf(entry, searchQuery);

                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 rounded-control border border-ios-separator bg-ios-card p-2.5 text-sm text-black"
                  >
                    <span>
                      {entry.title} <span className="text-ios-text-secondary">· {entry.category}</span>
                      <span className="ml-2 text-xs text-ios-text-secondary">
                        {kind === "exact" ? "Exact match" : "Partial match · keyword only"}
                      </span>
                    </span>
                    <Button
                      size="sm"
                      disabled={busyKey === entry.title}
                      onClick={() => void handleSelect(entry.title, undefined, entry.id)}
                    >
                      Add
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Phrase confirmation. The query is NOT saved as intent unless the
              candidate presses this, and the canonical occupation it maps to is
              shown beside it. */}
          {intentOffer !== null && (
            <div className="mt-3 rounded-control border border-ios-separator bg-ios-bg p-3 text-sm text-black">
              <p className="font-medium">Save this preference?</p>
              <p className="mt-1 text-ios-text-secondary">
                You searched for <span className="font-medium text-black">“{trimmedQuery}”</span>, which maps to{" "}
                <span className="font-medium text-black">{intentOffer.entry.title}</span> · {intentOffer.label}.
                Jobs matching {intentOffer.entry.title} will be ranked, not filtered, by this preference.
              </p>
              <Button
                size="sm"
                className="mt-2"
                disabled={busyKey === intentOffer.entry.title}
                onClick={() => void handleSelect(intentOffer.entry.title, trimmedQuery, intentOffer.entry.id)}
              >
                Save “{trimmedQuery}” as {intentOffer.entry.title}
              </Button>
            </div>
          )}

          {/* Related occupations: an explanation, and an explicit Add. They are
              never selected on the candidate's behalf. */}
          {relatedForQuery.length > 0 && (
            <div className="mt-3 rounded-control border border-ios-separator bg-ios-bg p-3 text-sm text-black">
              <p className="font-medium">Related roles</p>
              <ul className="mt-2 space-y-2">
                {relatedForQuery.map((related) => (
                  <li key={related.entry.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{related.entry.title}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyKey === related.entry.title}
                        onClick={() => void handleSelect(related.entry.title, undefined, related.entry.id)}
                      >
                        Add
                      </Button>
                    </div>
                    <p className="text-xs text-ios-text-secondary">{related.explanation}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {trimmedQuery !== "" && rawSearchResults.length === 0 && (
            <div className="mt-2 rounded-control border border-ios-separator bg-ios-bg p-3 text-sm text-black">
              <p className="font-medium">No matching roles found.</p>
              <p className="mt-1 text-ios-text-secondary">
                Add it as a custom role and JobBeacon will search for it exactly as written.
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={busyKey === trimmedQuery}
                onClick={() => void handleAddCustomRole()}
              >
                Add "{trimmedQuery}" as a custom role
              </Button>
            </div>
          )}

          {trimmedQuery !== "" && rawSearchResults.length > 0 && searchResults.length === 0 && (
            <p className="mt-2 text-sm text-ios-text-secondary">Every matching role is already in your list.</p>
          )}
        </section>

        {trimmedQuery === "" &&
          (["primary", "strong", "related"] as const).map((tier) =>
          suggestionsByTier[tier].length > 0 ? (
            <section key={tier}>
              <h3 className="text-sm font-semibold text-black">{TIER_LABELS[tier]}</h3>
              <ul className="mt-2 space-y-2">
                {suggestionsByTier[tier].map((suggestion) => (
                  <li
                    key={suggestion.entry.id}
                    className="flex items-center justify-between gap-2 rounded-control border border-ios-separator bg-ios-card p-2.5 text-sm text-black"
                  >
                    <span>
                      {suggestion.entry.title} <span className="text-ios-text-secondary">· {suggestion.entry.category}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyKey === suggestion.entry.title}
                      onClick={() => void handleSelect(suggestion.entry.title, undefined, suggestion.entry.id)}
                    >
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null,
        )}
      </CardContent>
    </Card>
  );
}
