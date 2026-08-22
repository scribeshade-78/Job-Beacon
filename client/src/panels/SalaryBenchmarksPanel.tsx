import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { listSalaryBenchmarks, type SalaryBenchmarkEntry } from "../lib/companyIntelligence";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

export function SalaryBenchmarksPanel() {
  const [benchmarks, setBenchmarks] = useState<SalaryBenchmarkEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSalaryBenchmarks(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setBenchmarks(result.benchmarks);
      } else {
        setError(result.message);
      }
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle id="salary-benchmarks-title">Salary Benchmarks</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="salary-benchmarks-title">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {benchmarks?.length === 0 && <p className="text-sm text-ios-text-secondary">No salary benchmarks published yet.</p>}
        <ul className="space-y-2 text-sm text-black">
          {benchmarks?.map((benchmark) => (
            <li key={benchmark.id}>
              {benchmark.roleLabel}
              {benchmark.region && ` (${benchmark.region})`}: {benchmark.salaryMin ?? "?"}–{benchmark.salaryMax ?? "?"}{" "}
              {benchmark.currency}/{benchmark.salaryInterval} — {benchmark.benchmarkSource}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
