import { describe, expect, it, vi } from "vitest";
import {
  getDiscoveryAdapter,
  hasDiscoveryAdapter,
  getRegisteredSourceCodes,
  discoveryAdapterRegistry,
} from "./registry.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";

describe("discoveryAdapterRegistry", () => {
  it("contains the greenhouse adapter", () => {
    expect(discoveryAdapterRegistry.has("greenhouse")).toBe(true);
    expect(discoveryAdapterRegistry.get("greenhouse")).toBe(greenhouseAdapter);
  });

  it("contains the lever adapter", () => {
    expect(discoveryAdapterRegistry.has("lever")).toBe(true);
    expect(discoveryAdapterRegistry.get("lever")).toBe(leverAdapter);
  });

  it("does not contain unregistered source codes", () => {
    expect(discoveryAdapterRegistry.has("adzuna")).toBe(false);
    expect(discoveryAdapterRegistry.has("usajobs")).toBe(false);
    expect(discoveryAdapterRegistry.has("not-a-real-source")).toBe(false);
  });

  it("getRegisteredSourceCodes returns all registered source codes", () => {
    const codes = getRegisteredSourceCodes();
    expect(codes).toContain("greenhouse");
    expect(codes).toContain("lever");
    expect(codes.length).toBe(2);
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

  it("throws for unregistered source code", () => {
    expect(() => getDiscoveryAdapter("adzuna")).toThrow(/No discovery adapter registered/);
    expect(() => getDiscoveryAdapter("not-a-real-source")).toThrow(/No discovery adapter registered/);
  });
});

describe("hasDiscoveryAdapter", () => {
  it("returns true for registered source codes", () => {
    expect(hasDiscoveryAdapter("greenhouse")).toBe(true);
    expect(hasDiscoveryAdapter("lever")).toBe(true);
  });

  it("returns false for unregistered source codes", () => {
    expect(hasDiscoveryAdapter("adzuna")).toBe(false);
    expect(hasDiscoveryAdapter("usajobs")).toBe(false);
    expect(hasDiscoveryAdapter("not-a-real-source")).toBe(false);
  });
});