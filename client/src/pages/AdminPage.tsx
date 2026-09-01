import { useState } from "react";
import {
  Activity,
  Gauge,
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
import { ModerationSection } from "./admin/ModerationSection";
import { TrustScoringSection } from "./admin/TrustScoringSection";
import { AdminCard, MockBadge } from "./admin/shared";

interface AdminPageProps {
  onLogout: () => void;
}

type SectionId =
  | "overview"
  | "sources"
  | "moderation"
  | "trust"
  | "users"
  | "errors"
  | "audit"
  | "settings";

const NAV: Array<{ id: SectionId; label: string; Icon: LucideIcon }> = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "sources", label: "Sources & Ingestion", Icon: Rss },
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

        <div className="flex-1">
          <header className="flex h-14 items-center justify-between border-b border-slate-800 px-5">
            <div className="flex gap-1 overflow-x-auto lg:hidden">
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
            {section === "moderation" && <ModerationSection />}
            {section === "trust" && <TrustScoringSection />}
            {section === "users" && <UsersBillingMock />}
            {section === "errors" && <ErrorsHealthMock />}
            {section === "audit" && <AuditLogMock />}
            {section === "settings" && <SettingsMock />}
          </main>
        </div>
      </div>
    </div>
  );
}

/* ---- Mock sections: no backing schema yet (subscriptions in R7,
   error_events / audit_logs later). Static placeholders so the console
   shell is complete; deleted wholesale when their real routes land. ---- */

function UsersBillingMock() {
  const rows = [
    { email: "priya@example.com", plan: "Pro", status: "active", mrr: "₹1,499" },
    { email: "arjun@example.com", plan: "Free", status: "—", mrr: "₹0" },
    { email: "meera@example.com", plan: "Pro", status: "past_due", mrr: "₹1,499" },
  ];
  return (
    <AdminCard title="Users & billing" description="Wired to a real subscriptions table in R7.">
      <div className="mb-3">
        <MockBadge />
      </div>
      <table className="w-full min-w-[480px] border-collapse text-left">
        <thead>
          <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-4 font-medium">User</th>
            <th className="py-2 pr-4 font-medium">Plan</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">MRR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.email} className="border-b border-slate-900">
              <td className="py-2 pr-4 text-sm text-slate-300">{row.email}</td>
              <td className="py-2 pr-4 text-xs text-slate-400">{row.plan}</td>
              <td className="py-2 pr-4 text-xs text-slate-400">{row.status}</td>
              <td className="py-2 pr-4 font-mono text-xs text-slate-300">{row.mrr}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminCard>
  );
}

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

function AuditLogMock() {
  const rows = [
    { at: "10:12", actor: "admin@jobbeacon", action: "source_policies.kill_switch → true (indeed)" },
    { at: "09:55", actor: "mod@jobbeacon", action: "moderation_decision: blocked case 8f2c" },
  ];
  return (
    <AdminCard title="Audit log" description="Wired to a real audit_logs table in a later phase.">
      <div className="mb-3">
        <MockBadge />
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.at} className="rounded border border-slate-800 bg-slate-950/40 p-3 text-sm">
            <span className="font-mono text-xs text-slate-500">{row.at}</span>{" "}
            <span className="text-slate-400">{row.actor}</span>
            <p className="mt-1 text-slate-300">{row.action}</p>
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
