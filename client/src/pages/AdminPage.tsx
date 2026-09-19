import { useState } from "react";
import { Link } from "wouter";
import {
  Activity,
  ArrowLeft,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Rss,
  ScrollText,
  Settings,
  ShieldAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { APP_NAME } from "../../../shared/app";
import { OverviewSection } from "./admin/OverviewSection";
import { SourcesSection } from "./admin/SourcesSection";
import { AtsCredentialsSection } from "./admin/AtsCredentialsSection";
import { AuditSection } from "./admin/AuditSection";
import { ModerationSection } from "./admin/ModerationSection";
import { TrustScoringSection } from "./admin/TrustScoringSection";
import { UsersBillingSection } from "./admin/UsersBillingSection";
import { AdminCard, MockBadge } from "./admin/shared";

interface AdminPageProps {
  onLogout: () => void;
}

type SectionId =
  | "overview"
  | "sources"
  | "ats"
  | "moderation"
  | "trust"
  | "users"
  | "errors"
  | "audit"
  | "settings";

const NAV: Array<{ id: SectionId; label: string; Icon: LucideIcon }> = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "sources", label: "Sources & Ingestion", Icon: Rss },
  { id: "ats", label: "ATS Credentials", Icon: KeyRound },
  { id: "moderation", label: "Moderation Queue", Icon: ShieldAlert },
  { id: "trust", label: "Trust Scoring", Icon: Gauge },
  { id: "users", label: "Users & Billing", Icon: Users },
  { id: "errors", label: "Errors & Health", Icon: Activity },
  { id: "audit", label: "Audit Log", Icon: ScrollText },
  { id: "settings", label: "Settings", Icon: Settings },
];

export function AdminPage({ onLogout }: AdminPageProps) {
  const [section, setSection] = useState<SectionId>("overview");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <div className="flex">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900/60 lg:flex">
          <div className="flex h-14 items-center px-5 text-sm font-bold text-slate-100">{APP_NAME} · Admin</div>
          <nav aria-label="Admin sections" className="flex flex-1 flex-col gap-1 px-3 py-4">
            {NAV.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={section === id ? "page" : undefined}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  section === id ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:bg-slate-800/60"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={onLogout}
            className="m-3 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800/60"
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
            Log out
          </button>
        </aside>

        {/* min-w-0 is load-bearing: a flex item defaults to min-width:auto
            (= its content width), so without it this column refuses to shrink
            below its widest child and the whole console scrolls sideways on
            a phone — the mobile header and its section tabs were 944px wide
            inside a 375px viewport. With it, the content that genuinely needs
            width (the sources table, already wrapped in overflow-x-auto)
            scrolls in its own box instead of dragging the page with it. */}
        <div className="min-w-0 flex-1">
          {/* Same bare-layout dead end as /employer and /moderator: this
              console renders outside AppShell and its sidebar nav has no
              route back to the candidate dashboard. A real Link to "/"
              rather than history.back(), which is undefined behaviour when
              this page is the first history entry. Styled in the console's
              own slate palette — the ios-* tokens the other two pages use
              hard-code text-black and would be unreadable on slate-950. */}
          <header className="flex h-14 items-center justify-between gap-3 border-b border-slate-800 px-5">
            <div className="flex min-w-0 items-center gap-3">
              <Link
                href="/"
                aria-label="Back to Dashboard"
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-800/60"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {/* Long label only once the layout has room for it (the lg
                    breakpoint this console's own sidebar appears at);
                    shortened below, never dropped. */}
                <span className="hidden lg:inline">Back to Dashboard</span>
                <span className="lg:hidden">Back</span>
              </Link>
              {/* min-w-0 is load-bearing, not decoration: a flex item
                  defaults to min-width:auto (= its content width), so without
                  it this row never shrinks below all nine section tabs and
                  the whole header — and the page — scrolls sideways on a
                  phone. overflow-x-auto only does its job once the box is
                  allowed to be narrower than its content. */}
              <div className="flex min-w-0 gap-1 overflow-x-auto lg:hidden">
                {NAV.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSection(id)}
                    className={`whitespace-nowrap rounded px-2 py-1 text-xs ${
                      section === id ? "bg-sky-500/15 text-sky-300" : "text-slate-500"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="hidden text-sm font-semibold text-slate-100 lg:inline">
                {NAV.find((item) => item.id === section)?.label}
              </span>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800/60 lg:hidden"
            >
              Log out
            </button>
          </header>

          <main className="mx-auto max-w-[1100px] space-y-4 p-5">
            {section === "overview" && <OverviewSection />}
            {section === "sources" && <SourcesSection />}
            {section === "ats" && <AtsCredentialsSection />}
            {section === "moderation" && <ModerationSection />}
            {section === "trust" && <TrustScoringSection />}
            {section === "users" && <UsersBillingSection />}
            {section === "errors" && <ErrorsHealthMock />}
            {section === "audit" && <AuditSection />}
            {section === "settings" && <SettingsMock />}
          </main>
        </div>
      </div>
    </div>
  );
}

/* ---- Mock sections: no backing schema yet (error_events later). Static
   placeholders so the console shell is complete; deleted wholesale when their
   real routes land.

   Users & Billing used to live here. Task H1 removed it: subscriptions,
   regional_prices, subscription_plans and plan_limits now exist, so the section
   reads real data and carries no mock badge.

   Audit Log used to live here too, and never should have been called one: the
   brief named audit_logs, but audit_logs is a table from a DIFFERENT codebase's
   document — PRD v3 §21.1's Audit domain names audit_events, and Task H4 built
   it. The section now reads audit_events and security_events through the real
   routes and carries no badge.

   What is left below is Errors & Health and Settings, both still waiting on
   tables (error_events, and any admin-config table). ---- */

function ErrorsHealthMock() {
  const rows = [
    { at: "10:04", service: "worker:fit", level: "error", message: "OpenAI 429 — backoff engaged" },
    { at: "09:41", service: "api", level: "warn", message: "slow query: candidate_opportunities 1.8s" },
  ];
  return (
    <AdminCard title="Errors & health" description="Wired to a real error_events table in a later phase.">
      <div className="mb-3">
        <MockBadge />
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.at} className="rounded border border-slate-800 bg-slate-950/40 p-3 text-sm">
            <span className="font-mono text-xs text-slate-500">{row.at}</span>{" "}
            <span className={row.level === "error" ? "text-rose-400" : "text-amber-400"}>{row.level}</span>{" "}
            <span className="text-slate-400">{row.service}</span>
            <p className="mt-1 text-slate-300">{row.message}</p>
          </li>
        ))}
      </ul>
    </AdminCard>
  );
}

function SettingsMock() {
  return (
    <AdminCard title="Settings" description="Placeholder — no admin-config table exists yet.">
      <div className="mb-3">
        <MockBadge />
      </div>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
          <dt className="text-slate-400">Maintenance mode</dt>
          <dd className="text-slate-500">off</dd>
        </div>
        <div className="flex justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2">
          <dt className="text-slate-400">Ingestion global pause</dt>
          <dd className="text-slate-500">off</dd>
        </div>
      </dl>
    </AdminCard>
  );
}
