import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Spinner } from "../components/ui/spinner";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

/**
 * How many auto-applications the candidate has left this week, per destination.
 *
 * WEEKLY, AND SAID SO. The allowance comes from plan_limits.max_auto_apply_*_per_week,
 * which is what M7 actually enforces. Showing a monthly figure here was the invisible
 * wall: a candidate paced themselves against a number nothing counted.
 *
 * THE UNATTRIBUTED LINE IS NOT DECORATION. Only the Adzuna adapter sets a vacancy's
 * country, so most applications belong to no destination at all. Without that line the
 * two bars would sum to less than the number of applications the candidate has actually
 * sent, and the card would look broken rather than honest.
 */

interface Dimension {
  dimension: string;
  prdLabel: string;
  limit: number | null;
  usage: number | null;
}

interface AutoApplyUsage {
  consumedThisPeriod: number;
  indiaConsumed: number;
  usConsumed: number;
}

function find(dimensions: Dimension[], id: string): Dimension | null {
  return dimensions.find((entry) => entry.dimension === id) ?? null;
}

export function AutoApplyLimitsPanel() {
  const [dimensions, setDimensions] = useState<Dimension[] | null>(null);
  const [usage, setUsage] = useState<AutoApplyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { data } = await getSupabaseBrowserClient().auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
          throw new Error("Not signed in.");
        }

        const response = await fetch("/api/billing/subscription", {
          headers: { Authorization: "Bearer " + token },
        });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }

        const body = (await response.json()) as {
          entitlements?: { evaluations?: Dimension[] };
          autoApplyUsage?: AutoApplyUsage;
        };

        if (cancelled) return;
        setDimensions(body.entitlements?.evaluations ?? []);
        setUsage(body.autoApplyUsage ?? null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const india = dimensions ? find(dimensions, "auto_apply_india_per_month") : null;
  const us = dimensions ? find(dimensions, "auto_apply_us_per_month") : null;

  // THERE IS NO COLUMN FOR THIS. It is the difference the data actually has, computed
  // rather than read, and floored at 0 so a transient inconsistency can never render a
  // negative count of applications.
  const unattributed = usage
    ? Math.max(0, usage.consumedThisPeriod - usage.indiaConsumed - usage.usConsumed)
    : 0;

  function Row({ label, used, limit }: { label: string; used: number; limit: number | null }) {
    const unlimited = limit === null;
    const exhausted = !unlimited && used >= limit;
    return (
      <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
        <span className="text-ios-text">{label}</span>
        <span className={exhausted ? "font-semibold text-status-blocked-fg" : "text-ios-text-secondary"}>
          {unlimited ? used + " sent" : used + " / " + limit}
        </span>
      </li>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto-apply this week</CardTitle>
      </CardHeader>
      <CardContent>
        {error !== null ? (
          <p role="alert" className="text-sm text-status-blocked-fg">
            Could not load your allowances: {error}
          </p>
        ) : dimensions === null || usage === null ? (
          <p className="flex items-center gap-2 text-sm text-ios-text-secondary">
            <Spinner /> Loading your allowances...
          </p>
        ) : (
          <>
            <ul className="divide-y divide-ios-separator">
              <Row label="India" used={usage.indiaConsumed} limit={india?.limit ?? null} />
              <Row label="United States" used={usage.usConsumed} limit={us?.limit ?? null} />
            </ul>

            {unattributed > 0 ? (
              <p className="mt-3 rounded-control border border-ios-separator bg-ios-bg px-3 py-2 text-xs text-ios-text-secondary">
                <span className="font-medium text-ios-text">{unattributed}</span>{" "}
                {unattributed === 1 ? "application" : "applications"} could not be attributed to a
                destination, because the listing did not state a country. They count towards your
                allowance but appear in neither line above.
              </p>
            ) : null}

            <p className="mt-3 text-xs text-ios-text-secondary">
              Allowances reset weekly.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
