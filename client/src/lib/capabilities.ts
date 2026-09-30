/**
 * The single source of truth for "what may this user reach", derived from
 * server-verified role data.
 *
 * WHY ONE MODEL. Navigation and routing must never disagree about who may see
 * what, and a scattered check (\`user.email === "..."\`, or an isAdmin read in one
 * component and a different one in another) is how a privileged surface ends up
 * reachable by a route that forgot to ask. Both the sidebar and the router call
 * the functions below, so a route cannot be added without stating its
 * capability.
 *
 * THESE FLAGS COME FROM THE SERVER, NEVER FROM THE CLIENT. The input is the
 * shape /api/me returns, where isModerator / isEmployer / isAdmin are each
 * resolved server-side: isModerator and isAdmin from public.user_roles (a
 * service_role-only table — 20260816222822_user_roles.sql), and isEmployer from
 * a *verified* employer_claims row. Nothing here reads a JWT claim, an email
 * address, or anything else the user controls.
 *
 * THIS IS DEFENCE IN DEPTH, NOT THE AUTHORIZATION BOUNDARY. Every privileged
 * API already has its own server middleware (requireAdmin, requireModeratorOrAdmin,
 * requireEmployerOf) and every privileged table has RLS. Hiding a route protects
 * the user from a dead end and the app from rendering another persona's shell;
 * it is not what stops a determined caller, and it must never be treated as if
 * it were.
 *
 * DENY BY DEFAULT, INCLUDING WHILE UNKNOWN. capabilitiesFromIdentity(null)
 * grants nothing, and the app renders a loading state rather than the children
 * of a protected route until the answer is known — so an unauthenticated or
 * still-resolving visitor can never flash privileged content.
 */

/** The server-verified signals /api/me returns. Typed loosely on purpose: this parses a network response. */
export interface RoleSignals {
  isModerator?: unknown;
  isAdmin?: unknown;
  isEmployer?: unknown;
}

/**
 * Explicit capabilities rather than role names, so a component asks "may I show
 * the moderation queue" instead of "is this person a moderator". That keeps the
 * one place that decides what a role means (below) instead of spreading the
 * mapping across every caller.
 */
export interface Capabilities {
  /** The ordinary candidate product: feed, applications, inbox, tasks, resume, billing. */
  canAccessCandidateApp: boolean;
  /** Submitting a company claim. Any authenticated user may do this — it is how someone becomes an employer. */
  canSubmitEmployerClaim: boolean;
  /** The approved employer portal. Requires a VERIFIED claim, and is per-company on the server. */
  canAccessEmployerPortal: boolean;
  /** The moderation experience. */
  canAccessModeration: boolean;
  /** The admin console. */
  canAccessAdmin: boolean;
}

/** Nothing granted. The value for a signed-out, unresolved, or failed identity. */
export const NO_CAPABILITIES: Capabilities = {
  canAccessCandidateApp: false,
  canSubmitEmployerClaim: false,
  canAccessEmployerPortal: false,
  canAccessModeration: false,
  canAccessAdmin: false,
};

/** Only a boolean true counts. A string "true", 1, or an object must not grant access. */
function isTrue(value: unknown): boolean {
  return value === true;
}

/**
 * Maps server-verified signals to capabilities.
 *
 * NULL MEANS DENY, which covers three cases that must not be distinguished here:
 * still loading, signed out, and the identity request failed. In all three the
 * safe answer is the same, and the caller decides whether to show a spinner or
 * redirect based on its own loading flag — the capability answer itself never
 * has to guess.
 *
 * ADMIN IMPLIES MODERATION, which is the EXISTING product rule rather than an
 * assumption: server/requireModeratorOrAdmin.ts authorizes on
 * (isModerator || isAdmin), and App.tsx already passed
 * \`isModerator || isAdmin\` as showModeratorLink for that reason. Encoding the
 * same union here keeps the nav and the API agreeing. Admin does NOT imply
 * employer portal access: an employer capability is about a verified claim on a
 * specific company, which is a different axis entirely.
 */
export function capabilitiesFromIdentity(identity: RoleSignals | null): Capabilities {
  if (identity === null) {
    return NO_CAPABILITIES;
  }

  const isAdmin = isTrue(identity.isAdmin);
  const isModerator = isTrue(identity.isModerator);

  return {
    // Any authenticated user reaches the candidate product.
    canAccessCandidateApp: true,
    // Likewise: claiming a company is a candidate action.
    canSubmitEmployerClaim: true,
    canAccessEmployerPortal: isTrue(identity.isEmployer),
    canAccessModeration: isModerator || isAdmin,
    canAccessAdmin: isAdmin,
  };
}

/**
 * A protected route and the one capability that opens it.
 *
 * THE ROUTER AND THE NAVIGATION READ THIS SAME LIST. A surface that is hidden
 * from the sidebar but still routable is the exact defect this task fixes, so
 * the two cannot be described in different places.
 */
export interface ProtectedRouteRule {
  path: string;
  capability: keyof Capabilities;
}

export const PROTECTED_ROUTES: readonly ProtectedRouteRule[] = [
  { path: "/admin", capability: "canAccessAdmin" },
  { path: "/moderator", capability: "canAccessModeration" },
  { path: "/employer", capability: "canAccessEmployerPortal" },
];

/**
 * The rule for a path, or null when the route is not protected.
 *
 * Exact match, deliberately: the app's routes are flat (\`/admin\` has no
 * children), and a prefix match would silently treat a future
 * \`/administer-your-own-data\` candidate route as privileged.
 */
export function protectedRouteFor(path: string): ProtectedRouteRule | null {
  return PROTECTED_ROUTES.find((rule) => rule.path === path) ?? null;
}

/** True only when the capability is present and exactly true. */
export function hasCapability(capabilities: Capabilities, capability: keyof Capabilities): boolean {
  return capabilities[capability] === true;
}
