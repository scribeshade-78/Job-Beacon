import { useEffect, useState } from "react";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { AppShell } from "./components/AppShell";
import { AuthCard } from "./components/AuthCard";
import { ConfirmationPendingScreen } from "./components/ConfirmationPendingScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { fetchVerifiedIdentity, useAuth, type VerifiedIdentity } from "./lib/auth";
import { ensureCandidateProfile } from "./lib/profile";
import { getSupabaseBrowserClient } from "./lib/supabaseClient";
import { ActionRequiredPage } from "./pages/ActionRequiredPage";
import { AdminPage } from "./pages/AdminPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { CompanyIntelligencePage } from "./pages/CompanyIntelligencePage";
import { EmployerPage } from "./pages/EmployerPage";
import { ModeratorPage } from "./pages/ModeratorPage";
import { OpportunitiesPage } from "./pages/OpportunitiesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ResponsesPage } from "./pages/ResponsesPage";
import { ResumesPage } from "./pages/ResumesPage";
import { SecurityPage } from "./pages/SecurityPage";
import { TargetRolesPage } from "./pages/TargetRolesPage";

interface SignedInRoutesProps {
  candidateId: string | undefined;
  ready: boolean;
  email: string | null;
  isModerator: boolean;
  isAdmin: boolean;
  identityError: string | null;
  profileError: string | null;
  onLogout: () => void;
}

/**
 * R3.1: /moderator renders bare (no AppShell) — the candidate sidebar
 * (Resumes, Target Roles, Opportunities, ...) doesn't fit the moderator
 * persona at all. useLocation() must run inside <Router>, which is why this
 * is a separate component rather than a branch inside App itself.
 */
function SignedInRoutes({
  candidateId,
  ready,
  email,
  isModerator,
  isAdmin,
  identityError,
  profileError,
  onLogout,
}: SignedInRoutesProps) {
  const [location] = useLocation();

  if (location === "/moderator") {
    return <ModeratorPage onLogout={onLogout} />;
  }

  // R8.1: renders bare, no candidate AppShell — same reasoning /moderator
  // uses, and rendered unconditionally at the path the same way: the real
  // authorization boundary is requireAdmin on every /api/admin/* route, so
  // a non-admin who reaches this URL just sees forbidden states from the
  // API, never candidate data. isAdmin (server-verified via /api/me) only
  // drives whether the nav link is shown, like showModeratorLink.
  if (location === "/admin") {
    return <AdminPage onLogout={onLogout} />;
  }

  // R5.4a: renders bare, no candidate AppShell — same reasoning /moderator
  // already uses (the candidate sidebar doesn't fit this persona either).
  // Reachable by any signed-in user regardless of isEmployer: submitting a
  // claim is how a candidate becomes one, so this can't be gated on
  // already being verified.
  if (location === "/employer") {
    return <EmployerPage onLogout={onLogout} />;
  }

  return (
    <AppShell email={email} onLogout={onLogout} showModeratorLink={isModerator || isAdmin} showAdminLink={isAdmin}>
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

    return (
      <Router hook={useHashLocation}>
        <SignedInRoutes
          candidateId={auth.user?.id}
          ready={ready}
          email={identity?.email ?? null}
          isModerator={identity?.isModerator ?? false}
          isAdmin={identity?.isAdmin ?? false}
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
