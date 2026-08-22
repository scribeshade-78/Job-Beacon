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

export function AuthCard({ onSignUp, onSignIn, error }: AuthCardProps) {
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

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
