import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Role management (admin console) — the server-side data layer behind
 * GET/POST/DELETE /api/admin/roles.
 *
 * WHY THIS EXISTS. public.user_roles (20260816222822_user_roles.sql) is
 * service_role-only at the grant level, so the only way to grant or revoke a
 * role is server code holding the service-role key. Before this module that
 * meant hand-written SQL or a Supabase dashboard session; the console now has
 * a real write path instead, and every write is audited by its route.
 *
 * EMAILS LIVE IN auth.users AND NOWHERE ELSE. No table in public exposes an
 * account's auth email, and Supabase's admin API has no "get user by email" —
 * only listUsers, one page at a time. So both the email enrichment and the
 * by-email lookup walk that list in bounded pages (see MAX_USER_PAGES) rather
 * than trusting a single page, which would report a real user as missing once
 * the account count passed one page.
 */

export type ManageableRole = "admin" | "moderator";

export const MANAGEABLE_ROLES: readonly ManageableRole[] = ["admin", "moderator"];

export function isManageableRole(value: unknown): value is ManageableRole {
  return typeof value === "string" && (MANAGEABLE_ROLES as readonly string[]).includes(value);
}

/** How many auth users are read per page. 1000 is the Supabase admin API's own maximum. */
export const USERS_PER_PAGE = 1000;

/**
 * Upper bound on the pages these functions will walk: 20,000 accounts.
 *
 * The bound exists because "walk until the list ends" is an unbounded loop
 * against an external API. Past this point the list is reported as truncated
 * rather than silently short, and a by-email grant stops searching — which is
 * why the number is high enough not to matter at this product's scale and the
 * truncation is surfaced on GET instead of being swallowed.
 */
export const MAX_USER_PAGES = 20;

export interface AuthUserRecord {
  id: string;
  /** Null for accounts with no email address (phone-only sign-ups). */
  email: string | null;
}

export interface AuthUserList {
  users: AuthUserRecord[];
  /** True when the page bound was reached with every page full — there may be more users. */
  truncated: boolean;
}

export interface ListAuthUsersOptions {
  /** Overridable so the truncation path is testable without fabricating 20,000 accounts. */
  maxPages?: number;
}

export async function listAuthUsers(
  client: SupabaseClient,
  options: ListAuthUsersOptions = {},
): Promise<AuthUserList> {
  const maxPages = Math.max(options.maxPages ?? MAX_USER_PAGES, 1);
  const users: AuthUserRecord[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });

    if (error) {
      throw error;
    }

    const batch = data?.users ?? [];

    for (const user of batch) {
      users.push({ id: user.id, email: user.email ?? null });
    }

    // A short page is the end of the list. A full one means there may be more,
    // so the walk continues — treating one page as the whole list is exactly
    // the bug this loop exists to avoid.
    if (batch.length < USERS_PER_PAGE) {
      return { users, truncated: false };
    }
  }

  return { users, truncated: true };
}

/** Trimmed and lower-cased, so a pasted address with different casing still matches. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Resolves a registered account by email, case-insensitively and ignoring
 * surrounding whitespace. Returns null only when no account matches — an auth
 * API failure throws, because reporting that as "no such user" would be a false
 * 404 on a grant.
 */
export async function findUserByEmail(client: SupabaseClient, email: string): Promise<AuthUserRecord | null> {
  const target = normalizeEmail(email);
  const { users } = await listAuthUsers(client);

  for (const user of users) {
    if (user.email !== null && normalizeEmail(user.email) === target) {
      return user;
    }
  }

  return null;
}

export interface RoleAssignment {
  userId: string;
  role: ManageableRole;
  createdAt: string;
  /** Null when the account has no email, or when it fell outside the page bound. */
  email: string | null;
}

export interface RoleAssignmentList {
  assignments: RoleAssignment[];
  truncated: boolean;
}

/**
 * Every row in user_roles, newest assignment last, enriched with the account's
 * email where one can be read.
 *
 * A FAILED EMAIL LOOKUP DEGRADES TO NULL, it does not fail the section — the
 * same trade-off server/admin/billing.ts already documents for this exact
 * lookup. The role rows are the authoritative data and are still returned;
 * refusing to render them because a display-only address could not be read
 * would hide the very state this screen exists to show. The failure is logged
 * loudly, because it is otherwise invisible.
 */
export async function listRoleAssignments(client: SupabaseClient): Promise<RoleAssignmentList> {
  const [rolesResult, users] = await Promise.all([
    client.from("user_roles").select("user_id, role, created_at").order("created_at"),
    listAuthUsers(client).catch((error: unknown) => {
      console.error("[admin:roles] auth user lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { users: [], truncated: false } satisfies AuthUserList;
    }),
  ]);

  if (rolesResult.error) {
    throw rolesResult.error;
  }

  const emailById = new Map<string, string>();

  for (const user of users.users) {
    if (user.email) {
      emailById.set(user.id, user.email);
    }
  }

  // The CHECK constraint on user_roles restricts role to ('moderator','admin'),
  // so this cast states what the database already guarantees rather than
  // re-validating it here.
  const rows = (rolesResult.data ?? []) as Array<{ user_id: string; role: ManageableRole; created_at: string }>;

  return {
    assignments: rows.map((row) => ({
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
      email: emailById.get(row.user_id) ?? null,
    })),
    truncated: users.truncated,
  };
}

export interface GrantRoleOutcome {
  /** The row already existed, so nothing was written. */
  alreadyHeld: boolean;
}

/**
 * Grants a role. Idempotent: a second grant of the same role is a no-op rather
 * than an error, and says so, because "this account is already an admin" is a
 * different answer from "granted".
 */
export async function grantRole(
  client: SupabaseClient,
  userId: string,
  role: ManageableRole,
): Promise<GrantRoleOutcome> {
  const { data, error } = await client
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();

  if (error) {
    throw error;
  }

  // Stated rather than inferred: "on conflict do nothing" cannot report whether
  // it inserted anything, and the caller answers the two cases differently.
  if (data) {
    return { alreadyHeld: true };
  }

  // ignoreDuplicates compiles to ON CONFLICT (user_id, role) DO NOTHING, so a
  // concurrent grant of the same role cannot raise a duplicate-key error.
  const { error: writeError } = await client
    .from("user_roles")
    .upsert({ user_id: userId, role }, { onConflict: "user_id,role", ignoreDuplicates: true });

  if (writeError) {
    throw writeError;
  }

  return { alreadyHeld: false };
}

/**
 * Revokes a role. Returns whether a row was actually removed, so the caller can
 * distinguish a revocation from a no-op instead of reporting both as success.
 */
export async function revokeRole(
  client: SupabaseClient,
  userId: string,
  role: ManageableRole,
): Promise<boolean> {
  const { data, error } = await client
    .from("user_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role", role)
    .select("user_id");

  if (error) {
    throw error;
  }

  return (data ?? []).length > 0;
}
