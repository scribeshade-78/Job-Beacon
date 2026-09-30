import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { AppShell } from "./AppShell";
import { capabilitiesFromIdentity, type Capabilities } from "../lib/capabilities";

/**
 * Navigation visibility, driven by the SAME capability object the router uses.
 *
 * The defect this pins: "Employer" sat unconditionally in NAV_ITEMS, so every
 * candidate saw a link to a portal they could not use. The mirror-image risk is
 * a link that is offered but refused by the route, which is why both read
 * lib/capabilities.ts rather than each deriving their own answer.
 */

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderShell(capabilities: Capabilities) {
  return render(
    <Router hook={useHashLocation}>
      <AppShell email="user@example.test" onLogout={() => {}} capabilities={capabilities}>
        <div>page contents</div>
      </AppShell>
    </Router>,
  );
}

/** The desktop sidebar, so the mobile drawer's duplicate links cannot satisfy an assertion. */
function nav() {
  return within(screen.getByLabelText("Main"));
}

const CANDIDATE = capabilitiesFromIdentity({ isModerator: false, isAdmin: false, isEmployer: false });

describe("candidate navigation", () => {
  it("offers no privileged destination", () => {
    renderShell(CANDIDATE);

    expect(nav().queryByText("Admin")).toBeNull();
    expect(nav().queryByText("Moderation")).toBeNull();
    expect(nav().queryByText("Employer portal")).toBeNull();
  });

  /**
   * The claim flow must stay reachable, or removing the Employer link would have
   * removed the only way to become an employer.
   */
  it("offers the account route for claiming a company", () => {
    renderShell(CANDIDATE);

    expect(nav().getByText("Employer access")).toBeTruthy();
  });

  it("still offers the ordinary candidate destinations", () => {
    renderShell(CANDIDATE);

    for (const label of ["Overview", "Opportunities", "Applications", "Security", "Plans & Billing"]) {
      expect(nav().getByText(label)).toBeTruthy();
    }
  });

  it("renders the page contents it was given", () => {
    renderShell(CANDIDATE);

    expect(screen.getByText("page contents")).toBeTruthy();
  });
});

describe("privileged navigation", () => {
  it("shows the admin console to an admin, along with moderation", () => {
    renderShell(capabilitiesFromIdentity({ isAdmin: true }));

    expect(nav().getByText("Admin")).toBeTruthy();
    expect(nav().getByText("Moderation")).toBeTruthy();
  });

  it("shows moderation but not admin to a moderator", () => {
    renderShell(capabilitiesFromIdentity({ isModerator: true }));

    expect(nav().getByText("Moderation")).toBeTruthy();
    expect(nav().queryByText("Admin")).toBeNull();
  });

  it("shows the employer portal to a verified employer only", () => {
    renderShell(capabilitiesFromIdentity({ isEmployer: true }));

    expect(nav().getByText("Employer portal")).toBeTruthy();
    expect(nav().queryByText("Admin")).toBeNull();
    expect(nav().queryByText("Moderation")).toBeNull();
  });

  /**
   * The employer portal and the claim page are different destinations with
   * different requirements; an employer still sees both.
   */
  it("keeps the claim route available to an employer as well", () => {
    renderShell(capabilitiesFromIdentity({ isEmployer: true }));

    expect(nav().getByText("Employer access")).toBeTruthy();
  });
});
