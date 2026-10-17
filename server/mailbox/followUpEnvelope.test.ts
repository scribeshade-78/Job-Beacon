import { describe, expect, it } from "vitest";
import { buildFollowUpEnvelope, ReplyAddressUnavailableError } from "./followUpEnvelope.js";
import { verifyReplyToken } from "./replyToken.js";

const SECRET = Buffer.alloc(32, 7);
const ATTEMPT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function input(overrides: Partial<Parameters<typeof buildFollowUpEnvelope>[0]> = {}) {
  return {
    attemptId: ATTEMPT,
    to: "jobs@acme.com",
    subject: "Re: Data Engineer application",
    text: "Hello, following up on my application.",
    candidateName: "Jane Doe",
    candidateAddress: "jane.doe@gmail.com",
    fromAddress: "notifications@jobbeacon.in",
    replyTokenSecret: SECRET,
    idempotencyKey: "draft-1",
    ...overrides,
  };
}

describe("buildFollowUpEnvelope", () => {
  it("sends as JobBeacon on the candidate's behalf, never pretending to be their mailbox", () => {
    const built = buildFollowUpEnvelope(input());

    expect(built.envelope.from).toEqual({
      name: "Jane Doe via JobBeacon",
      address: "notifications@jobbeacon.in",
    });
    expect(built.envelope.to).toBe("jobs@acme.com");
    expect(built.envelope.subject).toBe("Re: Data Engineer application");
    expect(built.envelope.idempotencyKey).toBe("draft-1");
  });

  it("mints a Reply-To that resolves back to THIS attempt", () => {
    const built = buildFollowUpEnvelope(input());

    expect(built.envelope.replyTo).toContain("jane.doe+");
    expect(built.envelope.replyTo.endsWith("@gmail.com")).toBe(true);

    // The Phase 17 verifier, on the Phase 18 envelope: the loop is closed, not assumed.
    expect(verifyReplyToken(built.envelope.replyTo, [ATTEMPT], SECRET)).toEqual({
      attemptId: ATTEMPT,
      version: 1,
    });
  });

  it("falls back to the brand alone when there is no confirmed name", () => {
    expect(buildFollowUpEnvelope(input({ candidateName: null })).envelope.from.name).toBe("JobBeacon");
    expect(buildFollowUpEnvelope(input({ candidateName: "   " })).envelope.from.name).toBe("JobBeacon");
  });

  it("normalises a recipient header down to its single address", () => {
    expect(buildFollowUpEnvelope(input({ to: "Acme Recruiting <jobs@acme.com>" })).envelope.to).toBe("jobs@acme.com");
  });

  it("refuses a recipient it cannot parse, rather than guessing one", () => {
    expect(() => buildFollowUpEnvelope(input({ to: "jobs@acme.com, other@acme.com" }))).toThrow(/recipient/);
    expect(() => buildFollowUpEnvelope(input({ to: "not an address" }))).toThrow(/recipient/);
  });

  it("refuses a subject that would inject a header or is empty", () => {
    expect(() => buildFollowUpEnvelope(input({ subject: "Re: hi\r\nBcc: evil@example.com" }))).toThrow(/single non-empty line/);
    expect(() => buildFollowUpEnvelope(input({ subject: "   " }))).toThrow(/single non-empty line/);
  });

  it("refuses an empty body", () => {
    expect(() => buildFollowUpEnvelope(input({ text: "  \n " }))).toThrow(/must not be empty/);
  });

  it("refuses when the reply token would exceed the local-part limit", () => {
    // 43 + 1 + 21 = 65, one octet over RFC 5321. A reply we cannot attribute must not be sent.
    expect(() => buildFollowUpEnvelope(input({ candidateAddress: "a".repeat(43) + "@gmail.com" }))).toThrow(
      ReplyAddressUnavailableError,
    );
  });

  it("records a digest of the exact body, so the sent record cannot drift from what was approved", () => {
    const first = buildFollowUpEnvelope(input());
    const second = buildFollowUpEnvelope(input());
    const changed = buildFollowUpEnvelope(input({ text: "Different words entirely." }));

    expect(first.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.bodySha256).toBe(first.bodySha256);
    expect(changed.bodySha256).not.toBe(first.bodySha256);
  });

  it("requires an idempotency key, because a send without one cannot be deduplicated", () => {
    expect(() => buildFollowUpEnvelope(input({ idempotencyKey: "  " }))).toThrow(/idempotency key/);
  });
});
