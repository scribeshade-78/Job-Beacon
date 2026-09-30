import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { StatusBadge, type StatusBadgeStatus } from "./ui/status-badge";
import { listMyEmployerClaims, submitEmployerClaim, type EmployerClaim } from "../lib/employer";
import { listCompaniesForReview, type ReviewableCompany } from "../lib/companyReviews";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

/**
 * Claiming a company profile — a CANDIDATE action, extracted from EmployerPage.
 *
 * WHY IT IS ITS OWN COMPONENT. Submitting a claim is how someone becomes an
 * employer, so it must stay reachable by any authenticated candidate, while the
 * employer PORTAL must not be. Those were the same page, which meant the portal
 * was reachable by anyone who could reach the claim form. Splitting the claim
 * flow out lets the account route host it for candidates and the portal route
 * require an approved employer, without duplicating the form or its validation.
 *
 * THE SERVER STILL OWNS THE DECISION. POST /api/employer/claims is
 * requireAuth-only by design (claiming is how you become an employer), and a
 * successful claim does not grant portal access — that follows a moderator's
 * decision, which is what isEmployer on /api/me reflects.
 */

const CLAIM_STATUS_BADGE: Record<EmployerClaim["status"], StatusBadgeStatus> = {
  pending: "under_review",
  verified: "verified",
  rejected: "fact_rejected",
};

async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

interface EmployerClaimSectionProps {
  /**
   * Reports the caller's claims whenever they load or change.
   *
   * The employer portal needs the same list to decide which companies the user
   * may administer, and re-fetching it there would be a second source of truth
   * that could disagree with what this section just showed.
   */
  onClaimsChange?: (claims: EmployerClaim[]) => void;
}

export function EmployerClaimSection({ onClaimsChange }: EmployerClaimSectionProps) {
  const [claims, setClaims] = useState<EmployerClaim[] | null>(null);
  const [companies, setCompanies] = useState<ReviewableCompany[] | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [representativeName, setRepresentativeName] = useState("");
  const [representativeRole, setRepresentativeRole] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function publish(next: EmployerClaim[]) {
    setClaims(next);
    onClaimsChange?.(next);
  }

  async function refreshClaims() {
    const result = await listMyEmployerClaims(getSupabaseBrowserClient());

    if (result.kind === "success") {
      publish(result.claims);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refreshClaims();

    listCompaniesForReview(getSupabaseBrowserClient()).then((result) => {
      if (result.kind === "success") {
        setCompanies(result.companies);
      } else {
        setError(result.message);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const result = await submitEmployerClaim(
      companyId,
      representativeName.trim(),
      representativeRole.trim(),
      evidence,
      accessToken,
    );

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

  // A claim can be resubmitted after rejection (unique(user_id, company_id)
  // upserts the same row) but not while already pending/verified — no
  // point offering the form for a company already in flight.
  const claimedCompanyIds = new Set(
    (claims ?? []).filter((claim) => claim.status !== "rejected").map((claim) => claim.companyId),
  );
  const claimableCompanies = (companies ?? []).filter((company) => !claimedCompanyIds.has(company.id));

  return (
    <>
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
    </>
  );
}
