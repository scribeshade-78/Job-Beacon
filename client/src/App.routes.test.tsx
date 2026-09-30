import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { SignedInRoutes } from "./App";
import { NO_CAPABILITIES, capabilitiesFromIdentity, type Capabilities } from "./lib/capabilities";

/**
 * Route-level authorization, exercised through the REAL SignedInRoutes.
 *
 * THE BUG BEING PINNED. App.tsx branched on the URL alone, so any signed-in user
 * who typed #/admin rendered the admin shell — the navigation hid the link, but
 * nothing stopped the route. These tests set the hash and render, which is as
 * close to "a candidate types #/admin" as a jsdom test gets.
 *
 * WHY THE ASSERTIONS ARE ON LANDMARKS. AdminPage renders a nav labelled
 * "Admin sections" and ModeratorPage renders a "Risk queue" card; asserting those
 * are ABSENT is asserting the component never mounted, which is the property that
 * matters. Checking for a heading would pass even if a shell had rendered.
 */

beforeEach(() => {
  // The privileged pages and the candidate shell both fetch on mount. Nothing
  // here is about their data, so every request resolves to an empty JSON body
  // rather than reaching the network.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function at(path: string) {
  window.location.hash = "#" + path;
}

const CANDIDATE = capabilitiesFromIdentity({ isModerator: false, isAdmin: false, isEmployer: false });
const ADMIN = capabilitiesFromIdentity({ isAdmin: true });
const MODERATOR = capabilitiesFromIdentity({ isModerator: true });
const EMPLOYER = capabilitiesFromIdentity({ isEmployer: true });

function renderRoutes(capabilities: Capabilities, pending = false) {
  return render(
    <Router hook={useHashLocation}>
      <SignedInRoutes
        candidateId="candidate-1"
        ready
        email="candidate@example.test"
        capabilities={capabilities}
        capabilitiesPending={pending}
        identityError={null}
        profileError={null}
        onLogout={() => {}}
      />
    </Router>,
  );
}

describe("privileged routes for a candidate", () => {
  it("does not mount the admin console at #/admin", () => {
    at("/admin");
    renderRoutes(CANDIDATE);

    expect(screen.queryByLabelText("Admin sections")).toBeNull();
  });

  it("does not mount the moderation surface at #/moderator", () => {
    at("/moderator");
    renderRoutes(CANDIDATE);

    expect(screen.queryByText(/Risk queue/)).toBeNull();
  });

  it("does not mount the employer portal at #/employer", () => {
    at("/employer");
    renderRoutes(CANDIDATE);

    expect(screen.queryByText(/Blocked vacancies/)).toBeNull();
  });
});

describe("privileged routes while capabilities are unresolved", () => {
  /**
   * DENY BY DEFAULT: an unresolved identity must render neither the page nor a
   * refusal. This is the state a real visitor is in for the first frame, so it is
   * the one that decides whether privileged content can flash.
   */
  it("mounts nothing privileged before the capability decision is known", () => {
    at("/admin");
    renderRoutes(NO_CAPABILITIES, true);

    expect(screen.queryByLabelText("Admin sections")).toBeNull();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });
});

describe("privileged routes for the correct role", () => {
  it("mounts the admin console for an admin", () => {
    at("/admin");
    renderRoutes(ADMIN);

    expect(screen.getByLabelText("Admin sections")).toBeTruthy();
  });

  it("mounts the moderation surface for a moderator", () => {
    at("/moderator");
    renderRoutes(MODERATOR);

    expect(screen.getByText(/Risk queue/)).toBeTruthy();
    expect(screen.queryByLabelText("Admin sections")).toBeNull();
  });

  it("mounts the employer portal for a verified employer", () => {
    at("/employer");
    renderRoutes(EMPLOYER);

    // The portal's own claim section is the stable marker; the point is that the
    // employer page rendered rather than being redirected away.
    expect(screen.getByText("Your claims")).toBeTruthy();
  });

  it("does not open the admin console for a moderator", () => {
    at("/admin");
    renderRoutes(MODERATOR);

    expect(screen.queryByLabelText("Admin sections")).toBeNull();
  });

  it("does not open the employer portal for an admin without a claim", () => {
    at("/employer");
    renderRoutes(ADMIN);

    expect(screen.queryByText("Your claims")).toBeNull();
  });
});

describe("the candidate-accessible claim route", () => {
  /**
   * Removing Employer from the navigation must not orphan the claim flow: this
   * page is how a candidate becomes an employer, and it stays reachable for every
   * signed-in candidate even though /employer does not.
   */
  it("renders the claim form for a candidate and states that access is not yet granted", () => {
    at("/account/employer-access");
    renderRoutes(CANDIDATE);

    expect(screen.getByText("Claim a company profile")).toBeTruthy();
    expect(screen.getByText("Employer portal not yet available")).toBeTruthy();
  });

  it("offers the portal from the account page only once access exists", () => {
    at("/account/employer-access");
    renderRoutes(EMPLOYER);

    expect(screen.getByText("You have employer access")).toBeTruthy();
    expect(screen.queryByText("Employer portal not yet available")).toBeNull();
  });
});
