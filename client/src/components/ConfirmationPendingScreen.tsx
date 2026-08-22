import { Card } from "./ui/card";

function MailIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="h-8 w-8 text-ios-blue">
      <rect x="3" y="7" width="26" height="18" rx="4" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 9l11.5 9 11.5-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ConfirmationPendingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ios-bg px-4 py-10">
      <Card className="flex w-full max-w-sm flex-col items-center gap-3 p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-ios-blue/10">
          <MailIcon />
        </div>
        <h1 className="text-xl font-semibold text-black">Check your email</h1>
        <p className="text-sm text-ios-text-secondary">
          We sent you a confirmation link. Open it to activate your account, then come back here to log in.
        </p>
      </Card>
    </div>
  );
}
