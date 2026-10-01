import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  AlertCircle,
  Briefcase,
  Building2,
  Building as BuildingIcon,
  CreditCard,
  FileText,
  Inbox,
  LayoutDashboard,
  Landmark,
  LogOut,
  Menu,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { APP_NAME } from "../../../shared/app";
import { cn } from "../lib/utils";
import type { Capabilities } from "../lib/capabilities";
import { CopilotDrawer } from "./CopilotDrawer";

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", Icon: LayoutDashboard },
  { href: "/profile", label: "Profile", Icon: User },
  { href: "/resumes", label: "Resumes", Icon: FileText },
  { href: "/target-roles", label: "Target Roles", Icon: Target },
  { href: "/opportunities", label: "Find Jobs", Icon: Briefcase },
  { href: "/applications", label: "Applications", Icon: Send },
  { href: "/responses", label: "Inbox", Icon: Inbox },
  { href: "/action-required", label: "Tasks", Icon: AlertCircle },
  { href: "/companies", label: "Companies", Icon: Building2 },
  // CLAIMING A COMPANY, NOT ENTERING THE EMPLOYER PORTAL. This replaced an
  // unconditional "Employer" link to /employer: the claim flow is a candidate
  // action, so it belongs under the account, while the portal itself requires an
  // approved employer and is listed conditionally below.
  { href: "/account/employer-access", label: "Employer access", Icon: Landmark },
  { href: "/security", label: "Security", Icon: ShieldCheck },
  { href: "/billing", label: "Plans & Billing", Icon: CreditCard },
];

interface AppShellProps {
  email: string | null;
  onLogout: () => void;
  children: ReactNode;
  /**
   * Server-verified capabilities, shared with the router.
   *
   * THE SAME OBJECT DRIVES BOTH, which is the point: the nav cannot offer a
   * destination the router would refuse, and a route cannot be protected
   * without the nav knowing. Each link below is justified by the identical
   * capability RequireCapability checks.
   *
   * A UX CONVENIENCE ONLY. Every matching API has its own middleware and every
   * privileged table has RLS; hiding a link is not what stops a caller.
   */
  capabilities: Capabilities;
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

export function AppShell({ email, onLogout, children, capabilities }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Each conditional entry is the navigation twin of one PROTECTED_ROUTES entry,
  // keyed on the same capability rather than on a separately-derived boolean.
  const navItems = [
    ...NAV_ITEMS,
    ...(capabilities.canAccessEmployerPortal ? [{ href: "/employer", label: "Employer portal", Icon: BuildingIcon }] : []),
    ...(capabilities.canAccessModeration ? [{ href: "/moderator", label: "Moderation", Icon: ShieldAlert }] : []),
    ...(capabilities.canAccessAdmin ? [{ href: "/admin", label: "Admin", Icon: SlidersHorizontal }] : []),
  ];

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
        {/* Mobile/tablet only. At lg+ this bar held nothing at all: its two
            children are both lg:hidden, so it rendered as a 64px empty band
            with a border, pushing every page's content down by 64px of dead
            white space while the sidebar already carried the branding two
            inches to its left. Hidden at lg+, main starts at the top of the
            viewport, and the brand row in the sidebar sits level with the
            first card. */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-ios-separator bg-ios-card/80 px-4 backdrop-blur-md sm:px-6 lg:hidden">
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

        {/* pb-28 on mobile reserves room for the Copilot launcher, a fixed 56px
            circle 24px off the bottom-right. Without it the launcher sits over
            the last job card or application action on a short page, where there
            is no further scroll to reveal what is underneath. At sm and up the
            sidebar layout means it rarely overlaps content, so this returns to
            the normal padding. */}
        <main className="mx-auto max-w-[1200px] p-6 pb-28 sm:pb-6">{children}</main>
      </div>

      {/* AI Career Copilot. Rendered here rather than per page so the floating
          trigger is reachable from every candidate view; absent from the
          moderator, admin and employer shells in App.tsx, which belong to other
          personas and render bare. */}
      <CopilotDrawer />
    </div>
  );
}
