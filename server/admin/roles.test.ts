import { describe, expect, it, vi } from "vitest";
import {
  findUserByEmail,
  grantRole,
  isManageableRole,
  listAuthUsers,
  listRoleAssignments,
  MAX_USER_PAGES,
  normalizeEmail,
  revokeRole,
  USERS_PER_PAGE,
} from "./roles.js";

type AuthClient = Parameters<typeof listAuthUsers>[0];

function makeAuthClient(pages: Array<Array<{ id: string; email?: string | null }>>) {
  const listUsers = vi.fn(async ({ page }: { page: number }) => ({
    data: { users: pages[page - 1] ?? [] },
    error: null,
  }));

  return { client: { auth: { admin: { listUsers } } } as unknown as AuthClient, listUsers };
}

/** A full page, which is what tells listAuthUsers there may be more to read. */
function fullPage(prefix: string) {
  return Array.from({ length: USERS_PER_PAGE }, (_, index) => ({
    id: prefix + "-" + index,
    email: prefix + index + "@example.com",
  }));
}

describe("isManageableRole", () => {
  it("accepts exactly the two roles this console can grant", () => {
    expect(isManageableRole("admin")).toBe(true);
    expect(isManageableRole("moderator")).toBe(true);
  });

  it("rejects anything else, including near-misses", () => {
    for (const value of ["superadmin", "Admin", "", null, undefined, 7, {}]) {
      expect(isManageableRole(value)).toBe(false);
    }
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases so a pasted address still matches", () => {
    expect(normalizeEmail("  Person@Example.COM ")).toBe("person@example.com");
  });
});

describe("listAuthUsers", () => {
  it("returns a single short page and does not claim truncation", async () => {
    const { client, listUsers } = makeAuthClient([[{ id: "u-1", email: "one@example.com" }]]);

    await expect(listAuthUsers(client)).resolves.toEqual({
      users: [{ id: "u-1", email: "one@example.com" }],
      truncated: false,
    });
    expect(listUsers).toHaveBeenCalledTimes(1);
    expect(listUsers).toHaveBeenCalledWith({ page: 1, perPage: USERS_PER_PAGE });
  });

  it("keeps walking while a page is full and stops at the first short page", async () => {
    const { client, listUsers } = makeAuthClient([fullPage("a"), [{ id: "last", email: "last@example.com" }]]);

    const result = await listAuthUsers(client);

    expect(result.users).toHaveLength(USERS_PER_PAGE + 1);
    expect(result.users[USERS_PER_PAGE]).toEqual({ id: "last", email: "last@example.com" });
    expect(result.truncated).toBe(false);
    expect(listUsers).toHaveBeenCalledTimes(2);
  });

  it("reports truncation when the page bound is reached with every page full", async () => {
    const { client, listUsers } = makeAuthClient([fullPage("a"), fullPage("b")]);

    const result = await listAuthUsers(client, { maxPages: 2 });

    expect(result.users).toHaveLength(USERS_PER_PAGE * 2);
    expect(result.truncated).toBe(true);
    expect(listUsers).toHaveBeenCalledTimes(2);
  });

  it("defaults the page bound to MAX_USER_PAGES", () => {
    expect(Number.isInteger(MAX_USER_PAGES)).toBe(true);
    expect(MAX_USER_PAGES).toBeGreaterThan(1);
  });

  it("throws when the admin API errors rather than reporting an empty list", async () => {
    const listUsers = vi.fn(async () => ({ data: null, error: { message: "auth down" } }));
    const client = { auth: { admin: { listUsers } } } as unknown as AuthClient;

    await expect(listAuthUsers(client)).rejects.toBeTruthy();
  });
});

describe("findUserByEmail", () => {
  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    const { client } = makeAuthClient([[{ id: "u-1", email: "Person@Example.com" }]]);

    await expect(findUserByEmail(client, "  person@example.COM ")).resolves.toEqual({
      id: "u-1",
      email: "Person@Example.com",
    });
  });

  it("returns null when no account matches", async () => {
    const { client } = makeAuthClient([[{ id: "u-1", email: "other@example.com" }]]);

    await expect(findUserByEmail(client, "nobody@example.com")).resolves.toBeNull();
  });

  it("skips accounts with no email address", async () => {
    const { client } = makeAuthClient([[{ id: "u-1", email: null }, { id: "u-2", email: "real@example.com" }]]);

    await expect(findUserByEmail(client, "real@example.com")).resolves.toEqual({
      id: "u-2",
      email: "real@example.com",
    });
  });

  it("finds an account that only appears on a later page", async () => {
    const { client } = makeAuthClient([fullPage("a"), [{ id: "u-late", email: "late@example.com" }]]);

    await expect(findUserByEmail(client, "late@example.com")).resolves.toEqual({
      id: "u-late",
      email: "late@example.com",
    });
  });
});

describe("listRoleAssignments", () => {
  function makeRolesClient(roleResult: { data: unknown; error: unknown }, pages: Array<Array<{ id: string; email?: string | null }>>) {
    const listUsers = vi.fn(async ({ page }: { page: number }) => ({
      data: { users: pages[page - 1] ?? [] },
      error: null,
    }));
    const from = vi.fn((table: string) => {
      if (table !== "user_roles") throw new Error("Unexpected table: " + table);
      return { select: () => ({ order: async () => roleResult }) };
    });

    return { client: { from, auth: { admin: { listUsers } } } as unknown as Parameters<typeof listRoleAssignments>[0] };
  }

  it("maps rows to camelCase and attaches the account email", async () => {
    const { client } = makeRolesClient(
      {
        data: [
          { user_id: "u-1", role: "admin", created_at: "2026-09-01T00:00:00Z" },
          { user_id: "u-2", role: "moderator", created_at: "2026-09-02T00:00:00Z" },
        ],
        error: null,
      },
      [[{ id: "u-1", email: "admin@example.com" }, { id: "u-2", email: null }]],
    );

    await expect(listRoleAssignments(client)).resolves.toEqual({
      assignments: [
        { userId: "u-1", role: "admin", createdAt: "2026-09-01T00:00:00Z", email: "admin@example.com" },
        { userId: "u-2", role: "moderator", createdAt: "2026-09-02T00:00:00Z", email: null },
      ],
      truncated: false,
    });
  });

  it("leaves the email null when the account is outside the page bound", async () => {
    const { client } = makeRolesClient(
      {
        data: [{ user_id: "u-1", role: "admin", created_at: "2026-09-01T00:00:00Z" }],
        error: null,
      },
      [fullPage("a"), fullPage("b")],
    );

    const result = await listRoleAssignments(client);

    expect(result.assignments[0].email).toBeNull();
  });

  it("still returns the role rows when the auth email lookup fails, and logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listUsers = vi.fn(async () => ({ data: null, error: { message: "auth down" } }));
    const from = vi.fn(() => ({
      select: () => ({
        order: async () => ({
          data: [{ user_id: "u-1", role: "admin", created_at: "2026-09-01T00:00:00Z" }],
          error: null,
        }),
      }),
    }));
    const client = { from, auth: { admin: { listUsers } } } as unknown as Parameters<typeof listRoleAssignments>[0];

    const result = await listRoleAssignments(client);

    expect(result.assignments).toEqual([
      { userId: "u-1", role: "admin", createdAt: "2026-09-01T00:00:00Z", email: null },
    ]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("throws when the user_roles query itself errors", async () => {
    const { client } = makeRolesClient({ data: null, error: { message: "db error" } }, [[]]);

    await expect(listRoleAssignments(client)).rejects.toBeTruthy();
  });
});

describe("grantRole", () => {
  function makeGrantClient(options: { existing?: unknown; selectError?: unknown; writeError?: unknown }) {
    const upsert = vi.fn(async () => ({ data: null, error: options.writeError ?? null }));
    const maybeSingle = vi.fn(async () => ({ data: options.existing ?? null, error: options.selectError ?? null }));
    const from = vi.fn(() => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
      upsert,
    }));

    return { client: { from } as unknown as Parameters<typeof grantRole>[0], upsert, maybeSingle };
  }

  it("reports alreadyHeld and writes nothing when the row exists", async () => {
    const { client, upsert } = makeGrantClient({ existing: { role: "admin" } });

    await expect(grantRole(client, "u-1", "admin")).resolves.toEqual({ alreadyHeld: true });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upserts with ignoreDuplicates when the row is absent, so a repeat cannot collide", async () => {
    const { client, upsert } = makeGrantClient({ existing: null });

    await expect(grantRole(client, "u-1", "moderator")).resolves.toEqual({ alreadyHeld: false });
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "u-1", role: "moderator" },
      { onConflict: "user_id,role", ignoreDuplicates: true },
    );
  });

  it("throws when the existence check errors", async () => {
    const { client } = makeGrantClient({ selectError: { message: "db error" } });

    await expect(grantRole(client, "u-1", "admin")).rejects.toBeTruthy();
  });

  it("throws when the write errors", async () => {
    const { client } = makeGrantClient({ writeError: { message: "db error" } });

    await expect(grantRole(client, "u-1", "admin")).rejects.toBeTruthy();
  });
});

describe("revokeRole", () => {
  function makeRevokeClient(result: { data: unknown; error: unknown }) {
    const from = vi.fn(() => ({
      delete: () => ({ eq: () => ({ eq: () => ({ select: async () => result }) }) }),
    }));

    return { client: { from } as unknown as Parameters<typeof revokeRole>[0] };
  }

  it("returns true when a row was removed", async () => {
    const { client } = makeRevokeClient({ data: [{ user_id: "u-1" }], error: null });

    await expect(revokeRole(client, "u-1", "admin")).resolves.toBe(true);
  });

  it("returns false when nothing matched, so a no-op is not reported as a revocation", async () => {
    const { client } = makeRevokeClient({ data: [], error: null });

    await expect(revokeRole(client, "u-1", "admin")).resolves.toBe(false);
  });

  it("throws when the delete errors", async () => {
    const { client } = makeRevokeClient({ data: null, error: { message: "db error" } });

    await expect(revokeRole(client, "u-1", "admin")).rejects.toBeTruthy();
  });
});
