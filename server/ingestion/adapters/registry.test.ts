import { describe, expect, it, vi } from "vitest";
import {
  getDiscoveryAdapter,
  hasDiscoveryAdapter,
  getRegisteredSourceCodes,
  discoveryAdapterRegistry,
} from "./registry.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { adzunaAdapter } from "./adzuna.js";
import { usajobsAdapter } from "./usajobs.js";

describe("discoveryAdapterRegistry", () => {
  it("contains the greenhouse adapter", () => {
    expect(discoveryAdapterRegistry.has("greenhouse")).toBe(true);
    expect(discoveryAdapterRegistry.get("greenhouse")).toBe(greenhouseAdapter);
  });

  it("contains the lever adapter", () => {
    expect(discoveryAdapterRegistry.has("lever")).toBe(true);
    expect(discoveryAdapterRegistry.get("lever")).toBe(leverAdapter);
  });

  it("contains the adzuna adapter (MP-A2.1)", () => {
    expect(discoveryAdapterRegistry.has("adzuna")).toBe(true);
    expect(discoveryAdapterRegistry.get("adzuna")).toBe(adzunaAdapter);
  });

  it("contains the usajobs adapter (MP-A2.1)", () => {
    expect(discoveryAdapterRegistry.has("usajobs")).toBe(true);
    expect(discoveryAdapterRegistry.get("usajobs")).toBe(usajobsAdapter);
  });

  it("does not contain unregistered source codes", () => {
    expect(discoveryAdapterRegistry.has("not-a-real-source")).toBe(false);
  });

  it("getRegisteredSourceCodes returns all registered source codes", () => {
    const codes = getRegisteredSourceCodes();
    expect(codes).toContain("greenhouse");
    expect(codes).toContain("lever");
    expect(codes).toContain("adzuna");
    expect(codes).toContain("usajobs");
    expect(codes.length).toBe(4);
  });
});

describe("getDiscoveryAdapter", () => {
  it("returns the greenhouse adapter for 'greenhouse'", () => {
    const adapter = getDiscoveryAdapter("greenhouse");
    expect(adapter).toBe(greenhouseAdapter);
  });

  it("returns the lever adapter for 'lever'", () => {
    const adapter = getDiscoveryAdapter("lever");
    expect(adapter).toBe(leverAdapter);
  });

  it("returns the adzuna adapter for 'adzuna' (MP-A2.1)", () => {
    const adapter = getDiscoveryAdapter("adzuna");
    expect(adapter).toBe(adzunaAdapter);
  });

  it("returns the usajobs adapter for 'usajobs' (MP-A2.1)", () => {
    const adapter = getDiscoveryAdapter("usajobs");
    expect(adapter).toBe(usajobsAdapter);
  });

  it("throws for unregistered source code", () => {
    expect(() => getDiscoveryAdapter("not-a-real-source")).toThrow(/No discovery adapter registered/);
  });
});

describe("hasDiscoveryAdapter", () => {
  it("returns true for registered source codes", () => {
    expect(hasDiscoveryAdapter("greenhouse")).toBe(true);
    expect(hasDiscoveryAdapter("lever")).toBe(true);
    expect(hasDiscoveryAdapter("adzuna")).toBe(true);
    expect(hasDiscoveryAdapter("usajobs")).toBe(true);
  });

  it("returns false for unregistered source codes", () => {
    expect(hasDiscoveryAdapter("not-a-real-source")).toBe(false);
  });
});