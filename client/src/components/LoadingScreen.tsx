import { Spinner } from "./ui/spinner";

export function LoadingScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ios-bg px-4">
      <Spinner className="h-9 w-9 text-ios-blue" />
      <p className="text-sm text-ios-text-secondary">Loading…</p>
    </div>
  );
}
