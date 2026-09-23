import { useId, useState, type FormEvent, type SVGProps } from "react";
import { APP_NAME } from "../../../shared/app";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Spinner } from "./ui/spinner";

export interface AuthCardProps {
  onSignUp: (email: string, password: string) => Promise<void>;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignInWithGoogle: () => Promise<void>;
  error?: string | null;
}

type Mode = "signIn" | "signUp";

// Deliberately permissive — this only gates the submit button locally for
// fast feedback; Supabase Auth remains the actual authority on whether an
// email/password is acceptable (see auth.ts's signUp/signIn, unchanged).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 6 chars matches Supabase Auth's own documented default minimum password
// length — not an invented rule, just surfaced earlier as UX feedback.
const MIN_PASSWORD_LENGTH = 6;

function EyeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function EyeOffIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path
        d="M2.5 2.5l15 15M8.3 8.4a2.5 2.5 0 003.4 3.4M6.2 6.2C3.8 7.4 1.5 10 1.5 10s3 6 8.5 6c1.4 0 2.6-.4 3.7-1M15.4 14.5c1.9-1.4 3.1-4.5 3.1-4.5s-3-6-8.5-6c-.7 0-1.4.1-2 .3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Google's official four-colour "G" mark, inline rather than an icon-font or
// CDN asset so the auth screen has no third-party request before sign-in.
function GoogleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="#4285F4"
        d="M23.06 12.25c0-.79-.07-1.54-.2-2.27H12v4.3h6.19a5.3 5.3 0 01-2.3 3.48v2.9h3.72c2.18-2 3.45-4.96 3.45-8.41z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.02-6.45-4.75H1.7v2.99A12 12 0 0012 24z"
      />
      <path fill="#FBBC05" d="M5.55 14.67a7.2 7.2 0 010-4.6V7.08H1.7a12 12 0 000 10.58l3.85-2.99z" />
      <path
        fill="#EA4335"
        d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.71 1.24 15.1 0 12 0A12 12 0 001.7 7.08l3.85 2.99C6.46 7.32 9 4.75 12 4.75z"
      />
    </svg>
  );
}

export function AuthCard({ onSignUp, onSignIn, onSignInWithGoogle, error }: AuthCardProps) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  const emailId = useId();
  const passwordId = useId();
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;

  function validate(): boolean {
    const nextEmailError = EMAIL_PATTERN.test(email) ? null : "Enter a valid email address.";
    const nextPasswordError =
      password.length >= MIN_PASSWORD_LENGTH ? null : `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);

    return nextEmailError === null && nextPasswordError === null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!validate()) {
      return;
    }

    setSubmitting(true);
    try {
      // Same onSignIn/onSignUp functions App.tsx already passes in — only
      // *which one* gets called depends on the segmented control's mode.
      await (mode === "signIn" ? onSignIn : onSignUp)(email, password);
    } finally {
      setSubmitting(false);
    }
  }

  // Separate from handleSubmit: there is no form to validate, and on success
  // the browser navigates to Google, so this state is only ever reset when the
  // call fails outright.
  async function handleGoogle() {
    setGoogleSubmitting(true);
    try {
      await onSignInWithGoogle();
    } finally {
      setGoogleSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ios-bg px-4 py-10">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-ios-blue text-xl font-bold text-white">
            JB
          </div>
          <h1 className="text-2xl font-semibold text-black">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-ios-text-secondary">
            {mode === "signIn" ? "Log in to continue" : "Create your account"}
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Choose log in or sign up"
          className="mb-6 grid grid-cols-2 gap-1 rounded-control bg-ios-bg p-1"
        >
          <button
            type="button"
            role="tab"
            id={`${emailId}-tab-signin`}
            aria-selected={mode === "signIn"}
            onClick={() => setMode("signIn")}
            className={cn(
              "h-9 rounded-[8px] text-sm font-semibold transition-colors",
              mode === "signIn" ? "bg-ios-card text-black shadow-control" : "text-ios-text-secondary hover:text-black",
            )}
          >
            Log in
          </button>
          <button
            type="button"
            role="tab"
            id={`${emailId}-tab-signup`}
            aria-selected={mode === "signUp"}
            onClick={() => setMode("signUp")}
            className={cn(
              "h-9 rounded-[8px] text-sm font-semibold transition-colors",
              mode === "signUp" ? "bg-ios-card text-black shadow-control" : "text-ios-text-secondary hover:text-black",
            )}
          >
            Sign up
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-control border border-status-blocked-fg/25 bg-status-blocked/8 px-3 py-2.5 text-sm text-status-blocked-fg"
          >
            {error}
          </p>
        )}

        {/* Shown in both modes on purpose. Supabase's OAuth call creates the
            account or signs into it — there is no separate "sign up with
            Google" — so hiding it behind the Sign up tab would make the same
            action appear and disappear for no reason the user can act on. */}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={handleGoogle}
          disabled={googleSubmitting}
        >
          {googleSubmitting ? (
            <>
              <Spinner className="h-4 w-4" />
              <span>Redirecting…</span>
            </>
          ) : (
            <>
              <GoogleIcon className="h-5 w-5" />
              <span>Continue with Google</span>
            </>
          )}
        </Button>

        <div className="my-4 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-ios-separator" />
          <span className="text-xs font-medium uppercase tracking-wide text-ios-text-secondary">or</span>
          <span className="h-px flex-1 bg-ios-separator" />
        </div>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              invalid={Boolean(emailError)}
              aria-describedby={emailError ? emailErrorId : undefined}
              required
            />
            {emailError && (
              <p id={emailErrorId} className="text-xs text-status-blocked-fg">
                {emailError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={passwordId}>Password</Label>
            <div className="relative">
              <Input
                id={passwordId}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? passwordErrorId : undefined}
                minLength={MIN_PASSWORD_LENGTH}
                className="pr-11"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-ios-text-secondary hover:text-black"
              >
                {showPassword ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
              </button>
            </div>
            {passwordError && (
              <p id={passwordErrorId} className="text-xs text-status-blocked-fg">
                {passwordError}
              </p>
            )}
          </div>

          <Button type="submit" disabled={submitting} className="mt-2 w-full">
            {submitting ? (
              <>
                <Spinner className="h-4 w-4" />
                <span>{mode === "signIn" ? "Logging in…" : "Signing up…"}</span>
              </>
            ) : mode === "signIn" ? (
              "Log in"
            ) : (
              "Sign up"
            )}
          </Button>
        </form>
      </Card>
    </div>
  );
}
