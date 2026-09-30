import { describe, expect, it } from "vitest";
import {
  NO_CAPABILITIES,
  PROTECTED_ROUTES,
  capabilitiesFromIdentity,
  hasCapability,
  protectedRouteFor,
} from "./capabilities";

describe("capabilitiesFromIdentity", () => {
  /**
   * THE CENTRAL SAFETY PROPERTY. Null covers "still loading", "signed out" and
   * "the identity request failed" — all three must grant nothing.
   */
  it("grants nothing when the identity is null", () => {
    expect(capabilitiesFromIdentity(null)).toEqual(NO_CAPABILITIES);
  });

  it("grants an ordinary candidate the candidate app and the claim flow only", () => {
    const capabilities = capabilitiesFromIdentity({
      isModerator: false,
      isAdmin: false,
      isEmployer: false,
    });

    expect(capabilities).toEqual({
      canAccessCandidateApp: true,
      canSubmitEmployerClaim: true,
      canAccessEmployerPortal: false,
      canAccessModeration: false,
      canAccessAdmin: false,
    });
  });

  it("opens only the employer portal for a verified employer", () => {
    const capabilities = capabilitiesFromIdentity({ isEmployer: true });

    expect(capabilities.canAccessEmployerPortal).toBe(true);
    expect(capabilities.canAccessAdmin).toBe(false);
    expect(capabilities.canAccessModeration).toBe(false);
  });

  it("opens moderation for a moderator but not admin", () => {
    const capabilities = capabilitiesFromIdentity({ isModerator: true });

    expect(capabilities.canAccessModeration).toBe(true);
    expect(capabilities.canAccessAdmin).toBe(false);
  });

  /**
   * NOT AN ASSUMPTION: server/requireModeratorOrAdmin.ts authorizes on
   * (isModerator || isAdmin), and the nav already treated an admin as a
   * moderator. Admin does NOT imply the employer portal — a verified claim on a
   * company is a different axis.
   */
  it("gives an admin the admin console and the moderation surface", () => {
    const capabilities = capabilitiesFromIdentity({ isAdmin: true });

    expect(capabilities.canAccessAdmin).toBe(true);
    expect(capabilities.canAccessModeration).toBe(true);
    expect(capabilities.canAccessEmployerPortal).toBe(false);
  });

  /**
   * The values arrive from a network response, so anything other than a real
   * boolean true must not grant access. A malformed or hostile payload that
   * says "true" (string), 1, or an object has to fail closed.
   */
  it("denies privileged access for malformed, non-boolean, or unknown role values", () => {
    const malformed = capabilitiesFromIdentity({
      isAdmin: "true",
      isModerator: 1,
      isEmployer: {},
    } as never);

    // The account is authenticated (the payload exists), so the ordinary
    // candidate product stays reachable — but only a real boolean true may open
    // a privileged surface, so every one of these must stay shut.
    expect(malformed.canAccessCandidateApp).toBe(true);
    expect(malformed.canAccessAdmin).toBe(false);
    expect(malformed.canAccessModeration).toBe(false);
    expect(malformed.canAccessEmployerPortal).toBe(false);
  });

  it("denies when role fields are absent entirely", () => {
    expect(capabilitiesFromIdentity({})).toEqual({
      canAccessCandidateApp: true,
      canSubmitEmployerClaim: true,
      canAccessEmployerPortal: false,
      canAccessModeration: false,
      canAccessAdmin: false,
    });
  });

  it("treats an explicit false as no access rather than falling back to a default", () => {
    const capabilities = capabilitiesFromIdentity({ isAdmin: false, isModerator: false, isEmployer: false });

    expect(capabilities.canAccessAdmin).toBe(false);
    expect(capabilities.canAccessModeration).toBe(false);
    expect(capabilities.canAccessEmployerPortal).toBe(false);
  });
});

describe("protectedRouteFor", () => {
  it("maps each privileged route to the one capability that opens it", () => {
    expect(protectedRouteFor("/admin")?.capability).toBe("canAccessAdmin");
    expect(protectedRouteFor("/moderator")?.capability).toBe("canAccessModeration");
    expect(protectedRouteFor("/employer")?.capability).toBe("canAccessEmployerPortal");
  });

  it("treats candidate routes as unprotected", () => {
    for (const path of ["/", "/applications", "/account/employer-access", "/jobs/abc"]) {
      expect(protectedRouteFor(path)).toBeNull();
    }
  });

  /**
   * Exact match, not prefix: a future candidate route that merely starts with
   * the same characters must not inherit a privileged rule.
   */
  it("does not prefix-match a candidate route against a privileged one", () => {
    expect(protectedRouteFor("/administrators-guide")).toBeNull();
    expect(protectedRouteFor("/moderator-notes")).toBeNull();
  });

  it("keeps the claim route reachable by candidates rather than listing it as protected", () => {
    expect(protectedRouteFor("/account/employer-access")).toBeNull();
  });
});

describe("hasCapability", () => {
  it("requires an exact true", () => {
    const capabilities = capabilitiesFromIdentity({ isAdmin: true });

    expect(hasCapability(capabilities, "canAccessAdmin")).toBe(true);
    expect(hasCapability(capabilities, "canAccessEmployerPortal")).toBe(false);
    expect(hasCapability(NO_CAPABILITIES, "canAccessCandidateApp")).toBe(false);
  });
});

describe("PROTECTED_ROUTES", () => {
  it("lists every privileged surface exactly once", () => {
    const paths = PROTECTED_ROUTES.map((rule) => rule.path);

    expect(new Set(paths).size).toBe(paths.length);
  });
});
