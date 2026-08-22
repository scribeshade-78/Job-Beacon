import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  enrollTotp,
  listTotpFactors,
  unenrollFactor,
  verifyEnrollment,
  type TotpEnrollment,
  type TotpFactorSummary,
} from "../lib/mfa";
import { revokeOtherSessions } from "../lib/session";
import { getSupabaseBrowserClient } from "../lib/supabaseClient";

export function SecurityPanel() {
  const [factors, setFactors] = useState<TotpFactorSummary[] | null>(null);
  const [pendingEnrollment, setPendingEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);

  async function refreshFactors() {
    const result = await listTotpFactors(getSupabaseBrowserClient());

    if (result.kind === "success") {
      setFactors(result.factors);
    } else {
      setError(result.message);
    }
  }

  useEffect(() => {
    void refreshFactors();
  }, []);

  async function handleEnroll() {
    setError(null);

    // A previously abandoned enrollment (e.g. the tab closed mid-QR-scan)
    // leaves an unverified factor behind, which GoTrue then rejects a new
    // enroll() against with a friendly-name conflict — since re-fetching a
    // QR/secret for an existing unverified factor isn't possible, clearing
    // it first is the only way to let the candidate start over.
    const stale = factors?.filter((factor) => factor.status === "unverified") ?? [];

    for (const factor of stale) {
      const cleanupResult = await unenrollFactor(getSupabaseBrowserClient(), factor.id);

      if (cleanupResult.kind === "error") {
        setError(cleanupResult.message);
        return;
      }
    }

    const result = await enrollTotp(getSupabaseBrowserClient());

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPendingEnrollment(result.enrollment);
  }

  async function handleVerify() {
    if (!pendingEnrollment) {
      return;
    }

    setError(null);
    const result = await verifyEnrollment(getSupabaseBrowserClient(), pendingEnrollment.factorId, code);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setPendingEnrollment(null);
    setCode("");
    await refreshFactors();
  }

  async function handleUnenroll(factorId: string) {
    setError(null);
    const result = await unenrollFactor(getSupabaseBrowserClient(), factorId);

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    await refreshFactors();
  }

  async function handleRevokeOtherSessions() {
    setError(null);
    setRevokeMessage(null);
    const result = await revokeOtherSessions(getSupabaseBrowserClient());

    if (result.kind === "error") {
      setError(result.message);
      return;
    }

    setRevokeMessage("Other sessions have been signed out.");
  }

  const verifiedFactor = factors?.find((factor) => factor.status === "verified") ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle id="security-title">Security</CardTitle>
      </CardHeader>
      <CardContent aria-labelledby="security-title" className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-status-blocked-fg">
            {error}
          </p>
        )}
        {revokeMessage && <p role="status" className="text-sm text-status-verified-fg">{revokeMessage}</p>}

        {verifiedFactor ? (
          <>
            <p className="text-sm text-black">Two-factor authentication is enabled.</p>
            <Button variant="destructive" onClick={() => void handleUnenroll(verifiedFactor.id)}>
              Turn off two-factor authentication
            </Button>
          </>
        ) : pendingEnrollment ? (
          <>
            <img
              // supabase-js's own mfa.enroll() already returns a complete
              // data: URI here (confirmed against installed @supabase/auth-js
              // source — its type-doc comment saying to prepend the prefix
              // yourself is stale), so this is used as-is, not re-wrapped.
              src={pendingEnrollment.qrCodeSvg}
              alt="Scan this QR code with your authenticator app"
              className="h-40 w-40"
            />
            <p className="text-sm text-ios-text-secondary">Or enter this code manually: {pendingEnrollment.secret}</p>
            <div className="space-y-1.5">
              <Label htmlFor="totp-code">Authenticator code</Label>
              <Input id="totp-code" value={code} onChange={(event) => setCode(event.target.value)} className="max-w-xs" />
            </div>
            <Button onClick={() => void handleVerify()}>Verify</Button>
          </>
        ) : (
          <Button onClick={() => void handleEnroll()}>Set up two-factor authentication</Button>
        )}

        <Button variant="secondary" onClick={() => void handleRevokeOtherSessions()}>
          Sign out other sessions
        </Button>
      </CardContent>
    </Card>
  );
}
