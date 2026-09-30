import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, LogOut } from "lucide-react";
import { APP_NAME } from "../../../shared/app";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { StatusBadge, type StatusBadgeStatus } from "../components/ui/status-badge";
import { type EmployerClaim } from "../lib/employer";
import { EmployerClaimSection } from "../components/EmployerClaimSection";
import { listCompaniesForReview, type ReviewableCompany } from "../lib/companyReviews";
import {
  listMyCompanyFactCorrections,
  submitCompanyFactCorrection,
  CORRECTABLE_FIELDS,
  CORRECTABLE_FIELD_LABELS,
  type CompanyFactCorrection,
  type CorrectableField,
} from "../lib/companyFactCorrections";
import { listBlockedVacancies, submitVacancyAppeal, type BlockedVacancyEntry } from "../lib/employerAppeals";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface EmployerPageProps {
  onLogout: () => void;
}

const CORRECTION_STATUS_BADGE: Record<CompanyFactCorrection["status"], StatusBadgeStatus> = {
  pending: "under_review",
  approved: "verified",
  rejected: "fact_rejected",
};

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export function EmployerPage({ onLogout }: EmployerPageProps) {
  const [claims, setClaims] = useState<EmployerClaim[] | null>(null);
  const [companies, setCompanies] = useState<ReviewableCompany[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [corrections, setCorrections] = useState<CompanyFactCorrection[] | null>(null);
  const [correctionCompanyId, setCorrectionCompanyId] = useState("");
  const [fieldName, setFieldName] = useState<CorrectableField | "">("");
  const [proposedValue, setProposedValue] = useState("");
  const [correctionEvidence, setCorrectionEvidence] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);

  const [blockedVacancies, setBlockedVacancies] = useState<Array<{ companyId: string } & BlockedVacancyEntry> | null>(null);
  const [appealingVacancyId, setAppealingVacancyId] = useState<string | null>(null);
  const [appealRationale, setAppealRationale] = useState("");
  const [appealEvidence, setAppealEvidence] = useState("");
  const [appealBusy, setAppealBusy] = useState(false);

  async function refreshCorrections() {
    const result = await listMyCompanyFactCorrections(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setCorrections(result.corrections);
    } else {
      setError(result.message);
    }
  }

  async function refreshBlockedVacancies(companyIds: string[]) {
    if (companyIds.length === 0) {
      setBlockedVacancies([]);
      return;
    }

    const accessToken = await getAccessToken();

    if (!accessToken) {
      return;
    }

    // listBlockedVacancies is per-company (mirrors the server route's
    // requireEmployerOf, which is company-scoped) — one call per verified
    // company, merged here; companyId is tagged back onto each entry since
    // the API response itself doesn't carry it (the route already knows
    // which company it's answering for).
    const results = await Promise.all(companyIds.map((id) => listBlockedVacancies(id, accessToken)));
    const merged: Array<{ companyId: string } & BlockedVacancyEntry> = [];

    results.forEach((result, index) => {
      if (result.kind === "success") {
        result.entries.forEach((entry) => merged.push({ companyId: companyIds[index], ...entry }));
      } else if (result.kind === "error") {
        setError(result.message);
      }
    });

    setBlockedVacancies(merged);
  }

  useEffect(() => {
    void refreshCorrections();

    listCompaniesForReview(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setCompanies(result.companies);
      } else {
        setError(result.message);
      }
    });
  }, []);

  useEffect(() => {
    if (claims === null) {
      return;
    }

    const verifiedIds = [...new Set(claims.filter((claim) => claim.status === "verified").map((claim) => claim.companyId))];
    void refreshBlockedVacancies(verifiedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims]);

  async function handleFileAppeal(entry: { companyId: string } & BlockedVacancyEntry) {
    setError(null);
    setNotice(null);

    if (appealRationale.trim() === "") {
      setError("Rationale is required to file an appeal.");
      return;
    }

    setAppealBusy(true);

    const accessToken = await getAccessToken();

    if (!accessToken) {
      setError("You must be signed in to file an appeal.");
      setAppealBusy(false);
      return;
    }

    const result = await submitVacancyAppeal(entry.companyId, entry.vacancyId, appealRationale.trim(), appealEvidence, accessToken);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setNotice("Appeal submitted. A different moderator than the one who made the original decision will review it.");
      setAppealingVacancyId(null);
      setAppealRationale("");
      setAppealEvidence("");
      const verifiedIds = [...new Set((claims ?? []).filter((claim) => claim.status === "verified").map((claim) => claim.companyId))];
      await refreshBlockedVacancies(verifiedIds);
    }

    setAppealBusy(false);
  }

  async function handleSubmitCorrection(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (correctionCompanyId === "" || fieldName === "" || proposedValue.trim() === "") {
      setError("Company, field, and new value are required.");
      return;
    }

    setCorrectionBusy(true);

    const accessToken = await getAccessToken();

    if (!accessToken) {
      setError("You must be signed in to submit a correction.");
      setCorrectionBusy(false);
      return;
    }

    const result = await submitCompanyFactCorrection(
      correctionCompanyId,
      fieldName,
      proposedValue.trim(),
      correctionEvidence,
      accessToken,
    );

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setNotice("Correction submitted. A moderator will review it before it takes effect.");
      setFieldName("");
      setProposedValue("");
      setCorrectionEvidence("");
      await refreshCorrections();
    }

    setCorrectionBusy(false);
  }

  // A claim can be resubmitted after rejection (unique(user_id, company_id)
  // upserts the same row) but not while already pending/verified — no
  // point offering the form for a company already in flight.
  // Corrections require §20.2's "verified employer" gate — a pending or
  // rejected claim doesn't authorize correcting a company's facts, only a
  // successful moderator decision on the claim itself does.
  const verifiedCompanyIds = new Set((claims ?? []).filter((claim) => claim.status === "verified").map((claim) => claim.companyId));
  const verifiedCompanies = (companies ?? []).filter((company) => verifiedCompanyIds.has(company.id));

  return (
    <div className="min-h-screen bg-ios-bg">
      {/* This page renders bare — App.tsx mounts /employer outside AppShell, so
          unlike every other candidate screen there is no sidebar and therefore
          no navigation at all. Without this link the only ways out were the
          browser's back button or logging out.

          Reachability changed with the route guard: /employer now requires an
          approved employer (RequireCapability), so a candidate no longer lands
          here by mistake, and the sidebar offers it only to someone who holds
          the capability. The escape hatch stays anyway, because "only the right
          people can arrive" is not the same as "they cannot get stuck" — a
          bookmarked URL, a revoked claim, or a stale tab all still land here.
          A real Link to "/" rather than history.back() — back() is undefined
          behaviour when this is the first entry in the history stack. */}
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-ios-separator bg-ios-card/80 px-6 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link
            href="/"
            aria-label="Back to Dashboard"
            className="flex shrink-0 items-center gap-1.5 rounded-control px-2.5 py-1.5 text-sm font-medium text-ios-blue hover:bg-ios-blue/10"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {/* Below sm the full label would crowd out the page title, so it
                shortens rather than disappearing — an icon-only control here
                would be the same discoverability problem this fixes. */}
            <span className="hidden sm:inline">Back to Dashboard</span>
            <span className="sm:hidden">Back</span>
          </Link>
          <span className="truncate text-base font-semibold text-black">
            <span className="hidden sm:inline">{APP_NAME} — </span>Employer
          </span>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex shrink-0 items-center gap-2 rounded-control px-3 py-1.5 text-sm font-medium text-black hover:bg-ios-bg"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Log out
        </button>
      </header>

      <main className="mx-auto max-w-[720px] space-y-6 p-6">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-status-verified-fg">
            {notice}
          </p>
        )}

        {/* Shared with /account/employer-access rather than duplicated here, so
            the claim form and its validation exist once. onClaimsChange keeps this
            page's own view of the claims (which decides the employer-only
            sections below) in step with what the section just did. */}
        <EmployerClaimSection onClaimsChange={setClaims} />

        {verifiedCompanies.length > 0 && (
          <>
            <Card>
              <CardHeader>
                <CardTitle id="blocked-vacancies-title">Blocked vacancies</CardTitle>
              </CardHeader>
              <CardContent aria-labelledby="blocked-vacancies-title">
                {blockedVacancies?.length === 0 && (
                  <p className="text-sm text-ios-text-secondary">No blocked vacancies right now.</p>
                )}
                <ul className="space-y-3">
                  {blockedVacancies?.map((entry) => (
                    <li key={entry.vacancyId} className="rounded-control border border-ios-separator p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-black">{entry.title || "(untitled)"}</span>
                        <StatusBadge status="blocked" />
                      </div>
                      <p className="mt-1 text-ios-text-secondary">
                        {entry.decisionRationale} <span>(policy {entry.decisionPolicyVersion})</span>
                      </p>

                      {entry.hasPendingAppeal ? (
                        <p className="mt-2 text-xs text-ios-text-secondary">Appeal pending review.</p>
                      ) : appealingVacancyId === entry.vacancyId ? (
                        <div className="mt-3 space-y-2">
                          <textarea
                            value={appealRationale}
                            onChange={(event) => setAppealRationale(event.target.value)}
                            disabled={appealBusy}
                            rows={3}
                            placeholder="Required — why this decision should be reconsidered."
                            className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <textarea
                            value={appealEvidence}
                            onChange={(event) => setAppealEvidence(event.target.value)}
                            disabled={appealBusy}
                            rows={2}
                            placeholder="Evidence (optional)."
                            className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <div className="flex gap-2">
                            <Button size="sm" disabled={appealBusy} onClick={() => void handleFileAppeal(entry)}>
                              {appealBusy ? "Submitting…" : "Submit appeal"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={appealBusy}
                              onClick={() => {
                                setAppealingVacancyId(null);
                                setAppealRationale("");
                                setAppealEvidence("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="mt-2"
                          onClick={() => {
                            setAppealingVacancyId(entry.vacancyId);
                            setAppealRationale("");
                            setAppealEvidence("");
                          }}
                        >
                          File an appeal
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle id="corrections-title">Your fact corrections</CardTitle>
              </CardHeader>
              <CardContent aria-labelledby="corrections-title">
                {corrections?.length === 0 && (
                  <p className="text-sm text-ios-text-secondary">No corrections submitted yet.</p>
                )}
                <ul className="space-y-2">
                  {corrections?.map((correction) => {
                    const company = companies?.find((c) => c.id === correction.companyId);
                    return (
                      <li
                        key={correction.id}
                        className="flex items-center justify-between gap-2 rounded-control border border-ios-separator p-3 text-sm text-black"
                      >
                        <span>
                          {company?.displayedName ?? correction.companyId} —{" "}
                          {CORRECTABLE_FIELD_LABELS[correction.fieldName]}: {correction.proposedValue}
                        </span>
                        <StatusBadge status={CORRECTION_STATUS_BADGE[correction.status]} />
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle id="correction-form-title">Correct a company fact</CardTitle>
              </CardHeader>
              <CardContent aria-labelledby="correction-form-title">
                <form onSubmit={handleSubmitCorrection} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="correctionCompany">Company</Label>
                    <select
                      id="correctionCompany"
                      value={correctionCompanyId}
                      onChange={(event) => setCorrectionCompanyId(event.target.value)}
                      disabled={correctionBusy}
                      className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">Select a company…</option>
                      {verifiedCompanies.map((company) => (
                        <option key={company.id} value={company.id}>
                          {company.displayedName}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="fieldName">Field</Label>
                    <select
                      id="fieldName"
                      value={fieldName}
                      onChange={(event) => setFieldName(event.target.value as CorrectableField | "")}
                      disabled={correctionBusy}
                      className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">Select a field…</option>
                      {CORRECTABLE_FIELDS.map((field) => (
                        <option key={field} value={field}>
                          {CORRECTABLE_FIELD_LABELS[field]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="proposedValue">New value</Label>
                    <Input
                      id="proposedValue"
                      value={proposedValue}
                      onChange={(event) => setProposedValue(event.target.value)}
                      disabled={correctionBusy}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="correctionEvidence">Evidence (optional)</Label>
                    <textarea
                      id="correctionEvidence"
                      value={correctionEvidence}
                      onChange={(event) => setCorrectionEvidence(event.target.value)}
                      disabled={correctionBusy}
                      rows={3}
                      placeholder="A source for this correction — a press release, an official filing, your careers page, etc."
                      className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>

                  <Button type="submit" disabled={correctionBusy}>
                    {correctionBusy ? "Submitting…" : "Submit correction"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
