import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EXCLUSION_CATEGORIES, listExclusions, setExclusion, type ExclusionCategory } from "../lib/exclusions";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

const EXCLUSION_LABELS: Record<ExclusionCategory, string> = {
  staffing_agencies: "Staffing agencies",
  contract_roles: "Contract roles",
  relocation_required: "Roles requiring relocation",
  sensitive_sectors: "Sensitive sectors",
};

interface ExclusionsPanelProps {
  candidateId: string;
}

export function ExclusionsPanel({ candidateId }: ExclusionsPanelProps) {
  const [active, setActive] = useState<Set<ExclusionCategory> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listExclusions(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setActive(new Set(result.categories));
      } else {
        setError(result.message);
      }
    });
  }, []);

  async function handleToggle(category: ExclusionCategory, checked: boolean) {
    setError(null);
    const result = await setExclusion(getSupabaseBrowserClient(), candidateId, category, checked);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setActive((previous) => {
      const next = new Set(previous ?? []);

      if (checked) {
        next.add(category);
      } else {
        next.delete(category);
      }

      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="exclusions-title">Exclusions</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="exclusions-title" className="space-y-2">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {EXCLUSION_CATEGORIES.map((category) => (
          <label key={category} className="flex items-center gap-2 text-sm text-black">
            <input
              type="checkbox"
              checked={active?.has(category) ?? false}
              onChange={(event) => void handleToggle(category, event.target.checked)}
              className="h-4 w-4 rounded border-ios-separator text-ios-blue-button focus-visible:outline-ios-blue"
            />
            {EXCLUSION_LABELS[category]}
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
