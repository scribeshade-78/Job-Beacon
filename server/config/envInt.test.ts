import { describe, expect, it } from "vitest";
import { readEnvInt } from "./envInt.js";

describe("readEnvInt", () => {
  it("falls back when the variable is absent", () => {
    expect(readEnvInt("MISSING", 42, {})).toBe(42);
  });

  it("falls back when the variable is empty", () => {
    expect(readEnvInt("EMPTY", 42, { EMPTY: "" })).toBe(42);
  });

  it("parses a value", () => {
    expect(readEnvInt("SET", 42, { SET: "1500" })).toBe(1_500);
  });

  it("honours zero, which means run flat out rather than never", () => {
    expect(readEnvInt("ZERO", 42, { ZERO: "0" })).toBe(0);
  });

  it("rejects a negative interval rather than reading it as never-run", () => {
    expect(readEnvInt("NEG", 42, { NEG: "-1" })).toBe(42);
  });

  it("rejects an unparseable value rather than producing NaN", () => {
    expect(readEnvInt("JUNK", 42, { JUNK: "soon" })).toBe(42);
  });

  it("reads a leading integer the way parseInt does", () => {
    expect(readEnvInt("PARTIAL", 42, { PARTIAL: "30s" })).toBe(30);
  });
});
