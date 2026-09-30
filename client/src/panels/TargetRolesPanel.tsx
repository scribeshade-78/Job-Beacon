import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { listSelectedRoles, removeRole, selectRole, type SelectedRole } from "../lib/candidateSelectedRoles";
import { listExtractedFacts, type ExtractedFact } from "../lib/resumeExtraction";
import { suggestRoles, type SuggestionTier } from "../lib/roleSuggestions";
import { searchRoles } from "../lib/roleTaxonomy";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface TargetRolesPanelProps {
  candidateId: string;
}

const TIER_LABELS: Record<SuggestionTier, string> = {
  primary: "Primary matches",
  strong: "Strong matches",
  related: "Related roles",
};

export function TargetRolesPanel({ candidateId }: TargetRolesPanelProps) {
  const [selectedRoles, setSelectedRoles] = useState<SelectedRole[] | null>(null);
  const [facts, setFacts] = useState<ExtractedFact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  async function handleSelect(title: string) {
    setError(null);
    setBusyKey(title);

    const result = await selectRole(getSupabaseBrowserClient(), candidateId, title);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
    }

    setBusyKey(null);
  }

  /**
   * A custom role is any name the candidate types: candidate_selected_roles
   * has no CHECK constraint, so this is the same write as picking a taxonomy
   * entry, just with the query as the name.
   */
  async function handleAddCustomRole() {
    const title = searchQuery.trim();
    if (title === "") return;

    setError(null);
    setBusyKey(title);

    const result = await selectRole(getSupabaseBrowserClient(), candidateId, title);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      // A custom name is not a taxonomy title, so leaving the query in place
      // would keep reporting zero results right after a successful add.
      setSearchQuery("");
      await refresh();
    }

    setBusyKey(null);
  }

  async function handleRemove(id: string) {
    setError(null);
    setBusyKey(id);

    const result = await removeRole(getSupabaseBrowserClient(), id);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      await refresh();
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
                className="flex items-center justify-between gap-2 rounded-control border border-ios-separator bg-ios-card p-2.5 text-sm text-black"
              >
                <span>{role.roleName}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busyKey === role.id}
                  onClick={() => void handleRemove(role.id)}
                >
                  Remove
                </Button>
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
              {searchResults.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-2 rounded-control border border-ios-separator bg-ios-card p-2.5 text-sm text-black"
                >
                  <span>
                    {entry.title} <span className="text-ios-text-secondary">· {entry.category}</span>
                  </span>
                  <Button size="sm" disabled={busyKey === entry.title} onClick={() => void handleSelect(entry.title)}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {/* Zero results is a state, not an empty list. Before this the panel
              simply showed nothing here and left the default tiers below, which
              is why a query the taxonomy cannot serve looked like no change. */}
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

        {/* The default tiers are hidden while a query is active: they are not
            answers to the query, and showing them under it is exactly what made
            an empty result look like an unchanged default. */}
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
                      onClick={() => void handleSelect(suggestion.entry.title)}
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
