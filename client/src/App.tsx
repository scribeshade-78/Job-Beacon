import { useEffect, useState } from "react";
import { Redirect, Route, Router, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { AppShell } from "./components/AppShell";
import { AuthCard } from "./components/AuthCard";
import { ConfirmationPendingScreen } from "./components/ConfirmationPendingScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { fetchVerifiedIdentity, useAuth, type AuthUser } from "./lib/auth";
import { ensureCandidateProfile } from "./lib/profile";
import { getSupabaseBrowserClient } from "./lib/supabaseClient";
import { ActionRequiredPage } from "./pages/ActionRequiredPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { CompanyIntelligencePage } from "./pages/CompanyIntelligencePage";
import { OpportunitiesPage } from "./pages/OpportunitiesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ResponsesPage } from "./pages/ResponsesPage";
import { ResumesPage } from "./pages/ResumesPage";
import { SecurityPage } from "./pages/SecurityPage";
import { TargetRolesPage } from "./pages/TargetRolesPage";

export function App() {
  const auth = useAuth();
  const [identity, setIdentity] = useState<AuthUser | null>(null);
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

    return (
      <Router hook={useHashLocation}>
        <AppShell email={identity?.email ?? null} onLogout={() => void auth.signOut()}>
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
              <OverviewPage candidateId={auth.user?.id} ready={ready} />
            </Route>
            <Route path="/profile">
              <ProfilePage candidateId={auth.user?.id} ready={ready} />
            </Route>
            <Route path="/resumes">
              <ResumesPage candidateId={auth.user?.id} ready={ready} />
            </Route>
            <Route path="/target-roles">
              <TargetRolesPage />
            </Route>
            <Route path="/opportunities">
              <OpportunitiesPage />
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
              <CompanyIntelligencePage />
            </Route>
            <Route path="/security">
              <SecurityPage />
            </Route>
            <Route>
              <Redirect to="/" />
            </Route>
          </Switch>
        </AppShell>
      </Router>
    );
  }

  return <AuthCard onSignUp={auth.signUp} onSignIn={auth.signIn} error={auth.status === "error" ? auth.error : null} />;
}
