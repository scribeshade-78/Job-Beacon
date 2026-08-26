import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertCircle,
  Briefcase,
  Building2,
  FileText,
  Inbox,
  LayoutDashboard,
  Landmark,
  LogOut,
  Menu,
  Send,
  ShieldAlert,
  ShieldCheck,
  Target,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { APP_NAME } from "../../../shared/app";
import { cn } from "../lib/utils";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", Icon: LayoutDashboard },
  { href: "/profile", label: "Profile", Icon: User },
  { href: "/resumes", label: "Resumes", Icon: FileText },
  { href: "/target-roles", label: "Target Roles", Icon: Target },
  { href: "/opportunities", label: "Opportunities", Icon: Briefcase },
  { href: "/applications", label: "Applications", Icon: Send },
  { href: "/responses", label: "Responses", Icon: Inbox },
  { href: "/action-required", label: "Action Required", Icon: AlertCircle },
  { href: "/companies", label: "Company Intelligence", Icon: Building2 },
  // R5.4a: unconditional (unlike the moderator link below) — submitting a
  // claim is how a candidate becomes an employer, so this can't be gated
  // on already being one.
  { href: "/employer", label: "Employer", Icon: Landmark },
  { href: "/security", label: "Security", Icon: ShieldCheck },
];

interface AppShellProps {
  email: string | null;
  onLogout: () => void;
  children: ReactNode;
  /** R3.1: shown only for moderators (server-verified via /api/me's isModerator) — a UX convenience, not the authorization boundary (requireModerator on the backend is). */
  showModeratorLink?: boolean;
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const [location] = useLocation();

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-4">
      {items.map(({ href, label, Icon }) => {
        const active = location === href;

        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-control px-3 py-2.5 text-[15px] font-medium transition-colors",
              active ? "bg-ios-blue/10 text-ios-blue" : "text-black hover:bg-ios-bg",
            )}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter({ email, onLogout }: { email: string | null; onLogout: () => void }) {
  return (
    <div className="border-t border-ios-separator p-3">
      {email && <p className="truncate px-3 py-1 text-xs text-ios-text-secondary">{email}</p>}
      <button
        type="button"
        onClick={onLogout}
        className="flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-[15px] font-medium text-black hover:bg-ios-bg"
      >
        <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
        Log out
      </button>
    </div>
  );
}

export function AppShell({ email, onLogout, children, showModeratorLink }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navItems = showModeratorLink
    ? [...NAV_ITEMS, { href: "/moderator", label: "Moderation", Icon: ShieldAlert }]
    : NAV_ITEMS;

  return (
    <div className="min-h-screen bg-ios-bg">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] flex-col border-r border-ios-separator bg-ios-card lg:flex">
        <div className="flex h-16 items-center px-5">
          <span className="text-lg font-bold text-black">{APP_NAME}</span>
        </div>
        <NavList items={navItems} />
        <SidebarFooter email={email} onLogout={onLogout} />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[260px] flex-col bg-ios-card shadow-card">
            <div className="flex h-16 items-center justify-between px-5">
              <span className="text-lg font-bold text-black">{APP_NAME}</span>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => setDrawerOpen(false)}
                className="rounded-control p-1.5 text-black hover:bg-ios-bg"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <NavList items={navItems} onNavigate={() => setDrawerOpen(false)} />
            <SidebarFooter email={email} onLogout={onLogout} />
          </aside>
        </div>
      )}

      <div className="lg:pl-[260px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-ios-separator bg-ios-card/80 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
            className="rounded-control p-1.5 text-black hover:bg-ios-bg lg:hidden"
          >
            <Menu className="h-6 w-6" aria-hidden="true" />
          </button>
          <span className="text-base font-semibold text-black lg:hidden">{APP_NAME}</span>
        </header>

        <main className="mx-auto max-w-[1200px] p-6">{children}</main>
      </div>
    </div>
  );
}
