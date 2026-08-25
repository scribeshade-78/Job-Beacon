import { describe, expect, it, vi } from "vitest";
import { createOAuthState, verifyOAuthState } from "./oauthState.js";

const SECRET = "test-state-secret";

describe("createOAuthState / verifyOAuthState", () => {
  it("round-trips a valid state", () => {
    const state = createOAuthState(SECRET, "candidate-1");
    expect(verifyOAuthState(SECRET, state)).toEqual({ candidateId: "candidate-1" });
  });

  it("rejects a state signed with a different secret", () => {
    const state = createOAuthState(SECRET, "candidate-1");
    expect(verifyOAuthState("wrong-secret", state)).toBeNull();
  });

  it("rejects a tampered payload (candidateId swapped)", () => {
    const state = createOAuthState(SECRET, "candidate-1");
    const [payloadB64, signature] = state.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    const tamperedPayloadB64 = Buffer.from(JSON.stringify({ ...payload, candidateId: "candidate-2" }), "utf8").toString(
      "base64url",
    );

    expect(verifyOAuthState(SECRET, `${tamperedPayloadB64}.${signature}`)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyOAuthState(SECRET, "not-a-valid-state")).toBeNull();
    expect(verifyOAuthState(SECRET, "")).toBeNull();
    expect(verifyOAuthState(SECRET, "a.b.c")).toBeNull();
  });

  it("rejects an expired state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const state = createOAuthState(SECRET, "candidate-1");

    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z")); // 11 minutes later, past the 10-minute TTL
    expect(verifyOAuthState(SECRET, state)).toBeNull();
    vi.useRealTimers();
  });
});
