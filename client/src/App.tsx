import { useEffect, useState, type FormEvent } from "react";
import { APP_NAME } from "../../shared/app";
import { fetchVerifiedIdentity, useAuth, type AuthUser } from "./lib/auth";
import { ensureCandidateProfile } from "./lib/profile";
import { getSupabaseBrowserClient } from "./lib/supabaseClient";

export function App() {
  const auth = useAuth();
  const [identity, setIdentity] = useState<AuthUser | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status !== "signedIn" || !auth.user) {
      setProfileError(null);
      return;
    }

    let cancelled = false;
    setProfileError(null);

    ensureCandidateProfile(getSupabaseBrowserClient(), auth.user.id).then((result) => {
      if (cancelled) {
        return;
      }

      if (result.kind === "error") {
        setProfileError(result.message);
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
    return (
      <main className="app-shell">
        <p>Loading…</p>
      </main>
    );
  }

  if (auth.status === "confirmationPending") {
    return (
      <main className="app-shell">
        <section aria-labelledby="app-title" className="foundation-card">
          <h1 id="app-title">{APP_NAME}</h1>
          <p>Check your email to confirm your account before logging in.</p>
        </section>
      </main>
    );
  }

  if (auth.status === "signedIn") {
    return (
      <main className="app-shell">
        <section aria-labelledby="app-title" className="foundation-card">
          <h1 id="app-title">{APP_NAME}</h1>
          {identityError && <p role="alert">{identityError}</p>}
          {profileError && <p role="alert">{profileError}</p>}
          {identity && <p>Signed in as {identity.email ?? identity.id}</p>}
          <button type="button" onClick={() => void auth.signOut()}>
            Log out
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section aria-labelledby="app-title" className="foundation-card">
        <h1 id="app-title">{APP_NAME}</h1>
        {auth.status === "error" && auth.error && <p role="alert">{auth.error}</p>}
        <AuthForm onSignUp={auth.signUp} onSignIn={auth.signIn} />
      </section>
    </main>
  );
}

interface AuthFormProps {
  onSignUp: (email: string, password: string) => Promise<void>;
  onSignIn: (email: string, password: string) => Promise<void>;
}

function AuthForm({ onSignUp, onSignIn }: AuthFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handle(action: (email: string, password: string) => Promise<void>) {
    setSubmitting(true);

    try {
      await action(email, password);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        autoComplete="email"
        required
      />

      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        required
      />

      <button type="button" disabled={submitting} onClick={() => void handle(onSignIn)}>
        Log in
      </button>
      <button type="button" disabled={submitting} onClick={() => void handle(onSignUp)}>
        Sign up
      </button>
    </form>
  );
}
