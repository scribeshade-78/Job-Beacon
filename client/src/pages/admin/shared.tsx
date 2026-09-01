import type { ReactNode } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabaseClient";

/**
 * R8.1 Admin Operations Panel is a bare, dark "ops console" — deliberately
 * not the light iOS-token candidate/moderator shell. These sections use
 * plain Tailwind slate/zinc utilities directly rather than the ios-* design
 * tokens or the Card/Button components (which hard-code `text-black` on
 * light surfaces and would be unreadable here).
 */

export async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabaseBrowserClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export function AdminCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">{title}</h2>
      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
      <div className="mt-4 text-sm text-slate-200">{children}</div>
    </section>
  );
}

export function SectionMessage({ tone, children }: { tone: "error" | "muted"; children: ReactNode }) {
  return (
    <p className={tone === "error" ? "text-sm text-rose-400" : "text-sm text-slate-500"} role={tone === "error" ? "alert" : undefined}>
      {children}
    </p>
  );
}

export function MockBadge() {
  return (
    <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
      Mock data
    </span>
  );
}
