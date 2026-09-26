import { describe, expect, it } from "vitest";
import {
  getIntakeAdapter,
  isTheMuseIntakeEnabled,
  listIntakeAdapters,
  THE_MUSE_INTAKE_FLAG,
} from "./registry.js";

/**
 * The registry's opt-in gate.
 *
 * This file exists because the flag is a SAFETY property, not a convenience:
 * The Muse is the one source whose terms and quota nobody has reviewed yet, so
 * "off unless an operator says otherwise" has to be asserted rather than
 * assumed. A regression here would start spending a third party's requests on
 * every candidate click without anyone choosing to.
 *
 * env is passed explicitly rather than stubbed on process.env, which is why
 * listIntakeAdapters takes it — the point of that parameter is to make this
 * exact assertion possible.
 */
const OFF: NodeJS.ProcessEnv = {};

describe("intake adapter registry — The Muse is opt-in", () => {
  it("is off when the flag is absent", () => {
    const codes = listIntakeAdapters(OFF).map((adapter) => adapter.sourceCode);

    expect(codes).not.toContain("themuse");
    expect(codes).toEqual(["remotive", "arbeitnow", "jooble", "adzuna"]);
  });

  it("is off for every value that is not exactly \"true\"", () => {
    // Fail-closed: a typo or a well-meaning "1" must not enable a source nobody
    // meant to turn on.
    for (const value of ["", "1", "yes", "TRUE", "True", "on", "false", "true "]) {
      expect(isTheMuseIntakeEnabled({ [THE_MUSE_INTAKE_FLAG]: value })).toBe(false);
      expect(listIntakeAdapters({ [THE_MUSE_INTAKE_FLAG]: value })).toHaveLength(4);
    }
  });

  it("is on for the exact string \"true\"", () => {
    const env = { [THE_MUSE_INTAKE_FLAG]: "true" };
    const codes = listIntakeAdapters(env).map((adapter) => adapter.sourceCode);

    expect(isTheMuseIntakeEnabled(env)).toBe(true);
    expect(codes).toEqual(["remotive", "arbeitnow", "jooble", "adzuna", "themuse"]);
  });

  it("keeps the always-on sources first, so the fan-out order is unchanged by opting in", () => {
    // The two keyless sources run first because they need no credential and no
    // candidate context, so a run still returns something when the credentialed
    // sources are skipped. An opt-in source must not displace that.
    const enabled = listIntakeAdapters({ [THE_MUSE_INTAKE_FLAG]: "true" });

    expect(enabled.slice(0, 4).map((adapter) => adapter.sourceCode)).toEqual([
      "remotive",
      "arbeitnow",
      "jooble",
      "adzuna",
    ]);
  });

  it("resolves the adapter only when it is enabled", () => {
    expect(() => getIntakeAdapter("themuse", OFF)).toThrow(/No intake adapter registered/);
    expect(getIntakeAdapter("themuse", { [THE_MUSE_INTAKE_FLAG]: "true" }).sourceCode).toBe("themuse");
  });

  it("names only the sources a caller could actually have used", () => {
    // Listing "themuse" to someone who could not have selected it is worse than
    // saying nothing: it reads as a source that exists but is broken.
    expect(() => getIntakeAdapter("nope", OFF)).toThrow(/Registered: remotive, arbeitnow, jooble, adzuna\./);
  });

  it("resolves an always-on source regardless of the flag", () => {
    expect(getIntakeAdapter("remotive", OFF).sourceCode).toBe("remotive");
    expect(getIntakeAdapter("arbeitnow", OFF).sourceCode).toBe("arbeitnow");
    expect(getIntakeAdapter("jooble", { [THE_MUSE_INTAKE_FLAG]: "true" }).sourceCode).toBe("jooble");
  });
});
