import { useEffect, useState } from "react";
import {
  getAdminTrustScores,
  getAdminTrustWeights,
  type TrustScoreEntry,
  type TrustWeights,
} from "../../lib/admin";
import { AdminCard, SectionMessage, getAccessToken } from "./shared";

export function TrustScoringSection() {
  const [scores, setScores] = useState<TrustScoreEntry[] | null>(null);
  const [weights, setWeights] = useState<TrustWeights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        if (!cancelled) setError("Your session has expired.");
        return;
      }

      const [scoresResult, weightsResult] = await Promise.all([
        getAdminTrustScores(accessToken),
        getAdminTrustWeights(accessToken),
      ]);
      if (cancelled) return;

      if (scoresResult.kind === "success") {
        setScores(scoresResult.data);
      } else if (scoresResult.kind === "forbidden") {
        setError("You don't have admin access.");
      } else {
        setError(scoresResult.message);
      }

      if (weightsResult.kind === "success") {
        setWeights(weightsResult.data);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <AdminCard
        title="Trust weights (§12.2)"
        description="PRD-verified constants from trustScore.ts — read-only. Making these configurable is a separate phase."
      >
        {weights === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {Object.entries(weights).map(([dimension, weight]) => (
              <li key={dimension} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
                <span className="text-xs text-slate-400">{dimension}</span>
                <span className="font-mono text-sm text-slate-200">{weight}</span>
              </li>
            ))}
          </ul>
        )}
      </AdminCard>

      <AdminCard title="Recent trust scores" description="Most recent rows from vacancy_trust_scores.">
        {error && <SectionMessage tone="error">{error}</SectionMessage>}

        {scores === null ? (
          <SectionMessage tone="muted">Loading…</SectionMessage>
        ) : scores.length === 0 ? (
          <SectionMessage tone="muted">No trust scores recorded yet.</SectionMessage>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Vacancy</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Score</th>
                  <th className="py-2 pr-4 font-medium">Policy</th>
                  <th className="py-2 pr-4 font-medium">Scored</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-900">
                    <td className="py-2 pr-4 text-sm text-slate-300">{entry.vacancyTitle || entry.vacancyId}</td>
                    <td className="py-2 pr-4 text-xs text-slate-400">{entry.status}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-300">{entry.score ?? "—"}</td>
                    <td className="py-2 pr-4 text-xs text-slate-500">{entry.policyVersion}</td>
                    <td className="py-2 pr-4 text-xs text-slate-500">{new Date(entry.scoredAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
