import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmployerClaimSection } from "../components/EmployerClaimSection";
import type { Capabilities } from "../lib/capabilities";

/**
 * Account → Employer access / Claim a company.
 *
 * WHY THIS EXISTS AS A SEPARATE ROUTE. The employer portal used to be the only
 * place to claim a company, which made "claim a company" and "you are an
 * employer" the same destination — so the portal had to stay open to everyone,
 * and a candidate who opened it saw an employer's shell. The two are now
 * different pages with different requirements: this one is a normal candidate
 * account page, and /employer requires an approved employer.
 *
 * IT DOES NOT PRETEND ACCESS HAS BEEN GRANTED. Nothing here says "your employer
 * account" or offers portal tools; the copy states that a claim is under review
 * and that the portal opens only after approval. The portal link appears only
 * when the server-verified capability says it will actually work, so it can
 * never lead to a refusal.
 */

interface EmployerAccessPageProps {
  capabilities: Capabilities;
}

export function EmployerAccessPage({ capabilities }: EmployerAccessPageProps) {
  return (
    <div className="mx-auto max-w-[720px] space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-black">Employer access</h2>
        <p className="mt-1 text-sm text-ios-text-secondary">
          Claim a company profile to manage its JobBeacon presence. A moderator reviews every claim, and
          claim submission is part of your normal candidate account — it does not change what else you can
          access.
        </p>
      </div>

      {capabilities.canAccessEmployerPortal ? (
        <Card>
          <CardHeader>
            <CardTitle id="portal-access-title">You have employer access</CardTitle>
          </CardHeader>
          <CardContent aria-labelledby="portal-access-title" className="space-y-3">
            <p className="text-sm text-ios-text-secondary">
              At least one of your claims has been approved, so the employer portal is available.
            </p>
            <Link
              href="/employer"
              className="inline-block rounded-control bg-ios-blue px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue focus-visible:ring-offset-2"
            >
              Open employer portal
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle id="no-portal-access-title">Employer portal not yet available</CardTitle>
          </CardHeader>
          <CardContent aria-labelledby="no-portal-access-title">
            <p className="text-sm text-ios-text-secondary">
              You don't have approved employer access yet. The portal unlocks after a moderator approves one
              of your claims — until then there is nothing there for you to use.
            </p>
          </CardContent>
        </Card>
      )}

      <EmployerClaimSection />
    </div>
  );
}
