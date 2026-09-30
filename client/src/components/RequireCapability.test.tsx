import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { RequireCapability } from "./RequireCapability";
import { NO_CAPABILITIES, capabilitiesFromIdentity } from "../lib/capabilities";

/**
 * The first component tests in this repository.
 *
 * WHY THEY EXIST AT ALL. "No privileged component mounts for an unauthorized
 * user" is not a claim a pure-logic test can make: the defect being fixed was a
 * RENDER decision (App.tsx branched on the URL alone), so proving it is fixed
 * means rendering the guard and asserting what reached the DOM. @testing-library/react
 * and jsdom are already dependencies and vitest already runs in jsdom, so this
 * uses the existing tooling rather than introducing any.
 *
 * A Router wrapper is required because the unauthorized branch renders <Redirect>,
 * which is meaningless outside one.
 */

afterEach(cleanup);

function renderGuarded(ui: React.ReactNode) {
  return render(<Router hook={useHashLocation}>{ui}</Router>);
}

const ADMIN_TITLE = "Admin console contents";
const MODERATION_TITLE = "Moderation queue contents";

function AdminChildren() {
  return <div>{ADMIN_TITLE}</div>;
}

describe("RequireCapability", () => {
  /**
   * THE FLASH PREVENTION. While capabilities are unresolved the children must not
   * be in the DOM at all — not hidden, not pending a redirect. A component that
   * mounts has already run its data fetching, so mounting is the exposure.
   */
  it("mounts nothing privileged while capabilities are still resolving", () => {
    renderGuarded(
      <RequireCapability capability="canAccessAdmin" capabilities={NO_CAPABILITIES} pending>
        <AdminChildren />
      </RequireCapability>,
    );

    expect(screen.queryByText(ADMIN_TITLE)).toBeNull();
    // It shows progress instead of a refusal, because the answer is not known yet.
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("does not mount the privileged children for a resolved candidate", () => {
    const candidate = capabilitiesFromIdentity({ isModerator: false, isAdmin: false, isEmployer: false });

    renderGuarded(
      <RequireCapability capability="canAccessAdmin" capabilities={candidate} pending={false}>
        <AdminChildren />
      </RequireCapability>,
    );

    expect(screen.queryByText(ADMIN_TITLE)).toBeNull();
  });

  it("does not mount the moderation surface for a plain candidate", () => {
    const candidate = capabilitiesFromIdentity({ isModerator: false, isAdmin: false });

    renderGuarded(
      <RequireCapability capability="canAccessModeration" capabilities={candidate} pending={false}>
        <div>{MODERATION_TITLE}</div>
      </RequireCapability>,
    );

    expect(screen.queryByText(MODERATION_TITLE)).toBeNull();
  });

  it("does not mount the employer portal for a candidate without an approved claim", () => {
    const candidate = capabilitiesFromIdentity({ isEmployer: false });

    renderGuarded(
      <RequireCapability capability="canAccessEmployerPortal" capabilities={candidate} pending={false}>
        <div>Employer portal contents</div>
      </RequireCapability>,
    );

    expect(screen.queryByText("Employer portal contents")).toBeNull();
  });

  it("mounts the surface for an admin", () => {
    const admin = capabilitiesFromIdentity({ isAdmin: true });

    renderGuarded(
      <RequireCapability capability="canAccessAdmin" capabilities={admin} pending={false}>
        <AdminChildren />
      </RequireCapability>,
    );

    expect(screen.getByText(ADMIN_TITLE)).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  /**
   * Admin reaches moderation too — the existing server rule
   * (requireModeratorOrAdmin) rather than an assumed hierarchy.
   */
  it("mounts the moderation surface for an admin as well as a moderator", () => {
    for (const identity of [{ isAdmin: true }, { isModerator: true }]) {
      const capabilities = capabilitiesFromIdentity(identity);

      const { unmount } = renderGuarded(
        <RequireCapability capability="canAccessModeration" capabilities={capabilities} pending={false}>
          <div>{MODERATION_TITLE}</div>
        </RequireCapability>,
      );

      expect(screen.getByText(MODERATION_TITLE)).toBeTruthy();
      unmount();
    }
  });

  it("mounts the employer portal for a verified employer", () => {
    const employer = capabilitiesFromIdentity({ isEmployer: true });

    renderGuarded(
      <RequireCapability capability="canAccessEmployerPortal" capabilities={employer} pending={false}>
        <div>Employer portal contents</div>
      </RequireCapability>,
    );

    expect(screen.getByText("Employer portal contents")).toBeTruthy();
  });

  /**
   * An employer is NOT an admin: the two are different axes, and a verified claim
   * on a company must never open the admin console.
   */
  it("does not let an employer reach the admin console", () => {
    const employer = capabilitiesFromIdentity({ isEmployer: true });

    renderGuarded(
      <RequireCapability capability="canAccessAdmin" capabilities={employer} pending={false}>
        <AdminChildren />
      </RequireCapability>,
    );

    expect(screen.queryByText(ADMIN_TITLE)).toBeNull();
  });
});
