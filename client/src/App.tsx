import { useEffect, useState } from "react";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { AppShell } from "./components/AppShell";
import { AuthCard } from "./components/AuthCard";
import { ConfirmationPendingScreen } from "./components/ConfirmationPendingScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { RequireCapability } from "./components/RequireCapability";
import { capabilitiesFromIdentity, protectedRouteFor, type Capabilities } from "./lib/capabilities";
import { fetchVerifiedIdentity, useAuth, type VerifiedIdentity } from "./lib/auth";
import { ensureCandidateProfile } from "./lib/profile";
import { getSupabaseBrowserClient } from "./lib/supabaseClient";
import { ActionRequiredPage } from "./pages/ActionRequiredPage";
import { AdminPage } from "./pages/AdminPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { BillingPage } from "./pages/BillingPage";
import { CompanyIntelligencePage } from "./pages/CompanyIntelligencePage";
import { EmployerAccessPage } from "./pages/EmployerAccessPage";
import { EmployerPage } from "./pages/EmployerPage";
import { JobDetailPage } from "./pages/JobDetailPage";
import { ModeratorPage } from "./pages/ModeratorPage";
import { OpportunitiesPage } from "./pages/OpportunitiesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ResponsesPage } from "./pages/ResponsesPage";
import { ResumesPage } from "./pages/ResumesPage";
import { SecurityPage } from "./pages/SecurityPage";
import { TargetRolesPage } from "./pages/TargetRolesPage";

export interface SignedInRoutesProps {
  candidateId: string | undefined;
  ready: boolean;
  email: string | null;
  /**
   * Server-verified capabilities. Replaces the previous isModerator/isAdmin
   * booleans so that routing and navigation cannot each re-derive access from a
   * different signal — see lib/capabilities.ts.
   */
  capabilities: Capabilities;
  /** True while /api/me has not answered yet. Denies by default; see RequireCapability. */
  capabilitiesPending: boolean;
  identityError: string | null;
  profileError: string | null;
  onLogout: () => void;
}

/**
 * R3.1: the privileged routes render bare (no AppShell) — the candidate sidebar
 * (Resumes, Target Roles, Opportunities, ...) doesn't fit those personas at all.
 * useLocation() must run inside <Router>, which is why this is a separate
 * component rather than a branch inside App itself.
 *
 * EVERY PRIVILEGED ROUTE GOES THROUGH RequireCapability. Before this, all three
 * were rendered on the strength of the URL alone — any signed-in user who typed
 * #/admin got the admin shell. The capability rule and the route component are
 * now decided by the same table (lib/capabilities.ts PROTECTED_ROUTES), so a
 * privileged path cannot be added here without naming the capability that opens
 * it.
 *
 * CLAIMING A COMPANY IS NOT HERE ANY MORE. It moved to /account/employer-access
 * (a normal candidate account page), which is what allows /employer to require an
 * approved employer without orphaning the claim flow.
 */
export function SignedInRoutes({
  candidateId,
  ready,
  email,
  capabilities,
  capabilitiesPending,
  identityError,
  profileError,
  onLogout,
}: SignedInRoutesProps) {
  const [location] = useLocation();

  const privilegedRoute = protectedRouteFor(location);

  if (privilegedRoute) {
    return (
      <RequireCapability
        capability={privilegedRoute.capability}
        capabilities={capabilities}
        pending={capabilitiesPending}
      >
        {location === "/moderator" ? (
          <ModeratorPage onLogout={onLogout} />
        ) : location === "/admin" ? (
          <AdminPage onLogout={onLogout} />
        ) : (
          <EmployerPage onLogout={onLogout} />
        )}
      </RequireCapability>
    );
  }

  return (
    <AppShell email={email} onLogout={onLogout} capabilities={capabilities}>
      {identityError && (
        <p role="alert" className="mb-4 text-sm text-status-blocked-fg">
          {identityError}
        </p>
      )}
      {profileError && (
        <p role="alert" className="mb-4 text-sm text-status-blocked-fg">
          {profileError}
        </p>
      )}

      <Switch>
        <Route path="/">
          <OverviewPage candidateId={candidateId} ready={ready} />
        </Route>
        <Route path="/profile">
          <ProfilePage candidateId={candidateId} ready={ready} />
        </Route>
        <Route path="/resumes">
          <ResumesPage candidateId={candidateId} ready={ready} />
        </Route>
        <Route path="/target-roles">
          <TargetRolesPage candidateId={candidateId} ready={ready} />
        </Route>
        <Route path="/opportunities">
          <OpportunitiesPage candidateId={candidateId} />
        </Route>
        {/* The internal listing view. Wouter's Route hands the matched param
            straight to the render prop, so the page receives jobId as a prop
            instead of re-parsing the hash. */}
        <Route path="/jobs/:jobId">
          {(params) => <JobDetailPage jobId={params.jobId} />}
        </Route>
        <Route path="/applications">
          <ApplicationsPage ready={ready} />
        </Route>
        <Route path="/responses">
          <ResponsesPage ready={ready} />
        </Route>
        <Route path="/action-required">
          <ActionRequiredPage ready={ready} />
        </Route>
        <Route path="/companies">
          <CompanyIntelligencePage candidateId={candidateId} ready={ready} />
        </Route>
        <Route path="/security">
          <SecurityPage />
        </Route>
        {/* The candidate-accessible employer claim flow, split out of the
            employer portal so that /employer can require an approved employer
            without taking the ability to claim a company away from candidates. */}
        <Route path="/account/employer-access">
          <EmployerAccessPage capabilities={capabilities} />
        </Route>
        <Route path="/billing">
          <BillingPage />
        </Route>
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </AppShell>
  );
}

export function App() {
  const auth = useAuth();
  const [identity, setIdentity] = useState<VerifiedIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  // candidate_profiles is the FK target for resume_documents,
  // candidate_exclusions, and automation_authorizations — panels backed by
  // those tables must not render (and let the candidate attempt an insert)
  // until this resolves, or a fast interaction on a slow connection hits a
  // foreign-key violation before the row exists.
  const [profileReady, setProfileReady] = useState(false);

  useEffect(() => {
    if (auth.status !== "signedIn" || !auth.user) {
      setProfileError(null);
      setProfileReady(false);
      return;
    }

    let cancelled = false;
    setProfileError(null);
    setProfileReady(false);

    ensureCandidateProfile(getSupabaseBrowserClient(), auth.user.id).then((result) => {
      if (cancelled) {
        return;
      }

      if (result.kind === "error") {
        setProfileError(result.message);
      } else {
        setProfileReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
    // Deliberately depends on auth.status only. TOKEN_REFRESHED keeps status
    // "signedIn" but issues a new session/access_token object — this must
    // run once per sign-in, not on every refresh. Widening this array
    // reintroduces a redundant insert attempt on every token refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== "signedIn" || !auth.session) {
      setIdentity(null);
      setIdentityError(null);
      return;
    }

    let cancelled = false;

    fetchVerifiedIdentity(getSupabaseBrowserClient(), auth.session.access_token).then((result) => {
      if (cancelled) {
        return;
      }

      if (result.kind === "success") {
        setIdentity(result.user);
        setIdentityError(null);
      } else if (result.kind === "unauthenticated") {
        void auth.signOut();
      } else {
        setIdentityError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.session?.access_token]);

  if (auth.status === "loading") {
    return <LoadingScreen />;
  }

  if (auth.status === "confirmationPending") {
    return <ConfirmationPendingScreen />;
  }

  if (auth.status === "signedIn") {
    const ready = Boolean(auth.user) && profileReady;

    // DENY BY DEFAULT WHILE UNKNOWN. capabilitiesFromIdentity(null) grants
    // nothing, and capabilitiesPending is what tells a protected route the
    // difference between "not allowed" and "not answered yet" — the first
    // redirects, the second must render neither the page nor a refusal.
    const capabilities = capabilitiesFromIdentity(identity);
    const capabilitiesPending = identity === null && identityError === null;

    return (
      <Router hook={useHashLocation}>
        <SignedInRoutes
          candidateId={auth.user?.id}
          ready={ready}
          email={identity?.email ?? null}
          capabilities={capabilities}
          capabilitiesPending={capabilitiesPending}
          identityError={identityError}
          profileError={profileError}
          onLogout={() => void auth.signOut()}
        />
      </Router>
    );
  }

  return (
    <AuthCard
      onSignUp={auth.signUp}
      onSignIn={auth.signIn}
      onSignInWithGoogle={auth.signInWithGoogle}
      error={auth.status === "error" ? auth.error : null}
    />
  );
}
