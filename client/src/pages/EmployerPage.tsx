import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { APP_NAME } from "../../../shared/app";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { StatusBadge, type StatusBadgeStatus } from "../components/ui/status-badge";
import { listMyEmployerClaims, submitEmployerClaim, type EmployerClaim } from "../lib/employer";
import { listCompaniesForReview, type ReviewableCompany } from "../lib/companyReviews";
import {
  listMyCompanyFactCorrections,
  submitCompanyFactCorrection,
  CORRECTABLE_FIELDS,
  CORRECTABLE_FIELD_LABELS,
  type CompanyFactCorrection,
  type CorrectableField,
} from "../lib/companyFactCorrections";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

interface EmployerPageProps {
  onLogout: () => void;
}

const CLAIM_STATUS_BADGE: Record<EmployerClaim["status"], StatusBadgeStatus> = {
  pending: "under_review",
  verified: "verified",
  rejected: "fact_rejected",
};

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
  const [companyId, setCompanyId] = useState("");
  const [representativeName, setRepresentativeName] = useState("");
  const [representativeRole, setRepresentativeRole] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [corrections, setCorrections] = useState<CompanyFactCorrection[] | null>(null);
  const [correctionCompanyId, setCorrectionCompanyId] = useState("");
  const [fieldName, setFieldName] = useState<CorrectableField | "">("");
  const [proposedValue, setProposedValue] = useState("");
  const [correctionEvidence, setCorrectionEvidence] = useState("");
  const [correctionBusy, setCorrectionBusy] = useState(false);

  async function refreshClaims() {
    const result = await listMyEmployerClaims(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setClaims(result.claims);
    } else {
      setError(result.message);
    }
  }

  async function refreshCorrections() {
    const result = await listMyCompanyFactCorrections(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setCorrections(result.corrections);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refreshClaims();
    void refreshCorrections();

    listCompaniesForReview(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setCompanies(result.companies);
      } else {
        setError(result.message);
      }
    });
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (companyId === "" || representativeName.trim() === "" || representativeRole.trim() === "") {
      setError("Company, your name, and your role are required.");
      return;
    }

    setBusy(true);

    const accessToken = await getAccessToken();

    if (!accessToken) {
      setError("You must be signed in to submit a claim.");
      setBusy(false);
      return;
    }

    const result = await submitEmployerClaim(companyId, representativeName.trim(), representativeRole.trim(), evidence, accessToken);

    if (result.kind === "error") {
      setError(result.message);
    } else {
      setNotice("Claim submitted. A moderator will review it — you'll see the outcome here.");
      setCompanyId("");
      setRepresentativeName("");
      setRepresentativeRole("");
      setEvidence("");
      await refreshClaims();
    }

    setBusy(false);
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
  const claimedCompanyIds = new Set((claims ?? []).filter((claim) => claim.status !== "rejected").map((claim) => claim.companyId));
  const claimableCompanies = (companies ?? []).filter((company) => !claimedCompanyIds.has(company.id));

  // Corrections require §20.2's "verified employer" gate — a pending or
  // rejected claim doesn't authorize correcting a company's facts, only a
  // successful moderator decision on the claim itself does.
  const verifiedCompanyIds = new Set((claims ?? []).filter((claim) => claim.status === "verified").map((claim) => claim.companyId));
  const verifiedCompanies = (companies ?? []).filter((company) => verifiedCompanyIds.has(company.id));

  return (
    <div className="min-h-screen bg-ios-bg">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-ios-separator bg-ios-card/80 px-6 backdrop-blur-md">
        <span className="text-base font-semibold text-black">{APP_NAME} — Employer</span>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 rounded-control px-3 py-1.5 text-sm font-medium text-black hover:bg-ios-bg"
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

        <Card>
          <CardHeader>
            <CardTitle id="claims-title">Your claims</CardTitle>
          </CardHeader>
          <CardContent aria-labelledby="claims-title">
            {claims?.length === 0 && (
              <p className="text-sm text-ios-text-secondary">
                You haven't claimed a company profile yet. Submit a claim below.
              </p>
            )}
            <ul className="space-y-2">
              {claims?.map((claim) => {
                const company = companies?.find((c) => c.id === claim.companyId);
                return (
                  <li
                    key={claim.id}
                    className="flex items-center justify-between gap-2 rounded-control border border-ios-separator p-3 text-sm text-black"
                  >
                    <span>{company?.displayedName ?? claim.companyId}</span>
                    <StatusBadge status={CLAIM_STATUS_BADGE[claim.status]} />
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle id="claim-form-title">Claim a company profile</CardTitle>
          </CardHeader>
          <CardContent aria-labelledby="claim-form-title">
            {claimableCompanies.length === 0 && companies !== null ? (
              <p className="text-sm text-ios-text-secondary">No unclaimed companies available to claim right now.</p>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="company">Company</Label>
                  <select
                    id="company"
                    value={companyId}
                    onChange={(event) => setCompanyId(event.target.value)}
                    disabled={busy}
                    className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">Select a company…</option>
                    {claimableCompanies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.displayedName}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="representativeName">Your name</Label>
                  <Input
                    id="representativeName"
                    value={representativeName}
                    onChange={(event) => setRepresentativeName(event.target.value)}
                    disabled={busy}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="representativeRole">Your role at the company</Label>
                  <Input
                    id="representativeRole"
                    value={representativeRole}
                    onChange={(event) => setRepresentativeRole(event.target.value)}
                    disabled={busy}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="evidence">Evidence of authority (optional)</Label>
                  <textarea
                    id="evidence"
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    disabled={busy}
                    rows={3}
                    placeholder="A link to your profile on the company's careers page, an offer letter reference, etc. — a moderator reviews every claim, this helps them confirm it."
                    className="w-full rounded-control border border-ios-separator bg-ios-card px-3.5 py-2.5 text-[15px] text-black placeholder:text-ios-text-secondary focus-visible:border-ios-blue disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>

                <Button type="submit" disabled={busy}>
                  {busy ? "Submitting…" : "Submit claim"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {verifiedCompanies.length > 0 && (
          <>
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
