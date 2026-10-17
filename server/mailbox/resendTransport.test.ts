import { describe, expect, it, vi } from "vitest";
import type { OutboundEnvelope } from "./mailTransport.js";
import { MailTransportError } from "./mailTransport.js";
import { createResendTransport, readResendConfig, RESEND_ENDPOINT } from "./resendTransport.js";

const ENVELOPE: OutboundEnvelope = {
  from: { name: "Jane Doe via JobBeacon", address: "notifications@jobbeacon.in" },
  to: "jobs@acme.com",
  replyTo: "jane.doe+TOKEN@gmail.com",
  subject: "Re: Data Engineer application",
  text: "Hello, following up.",
  idempotencyKey: "draft-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function transportWith(response: Response) {
  const fetchImpl = vi.fn(async () => response);
  return {
    transport: createResendTransport({ apiKey: "re_test", fetchImpl: fetchImpl as unknown as typeof fetch }),
    fetchImpl,
  };
}

describe("createResendTransport", () => {
  it("sends the verified Resend payload with the idempotency key", async () => {
    const { transport, fetchImpl } = transportWith(jsonResponse({ id: "email-123" }));

    const result = await transport.send(ENVELOPE);

    expect(result).toEqual({ providerMessageId: "email-123" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    expect(headers["Content-Type"]).toBe("application/json");
    // What makes a retry safe rather than a second email.
    expect(headers["Idempotency-Key"]).toBe("draft-1");

    expect(JSON.parse(String(init.body))).toEqual({
      from: "Jane Doe via JobBeacon <notifications@jobbeacon.in>",
      to: ["jobs@acme.com"],
      subject: "Re: Data Engineer application",
      // Resend's snake_case field, verified against its API reference.
      reply_to: "jane.doe+TOKEN@gmail.com",
      text: "Hello, following up.",
    });
  });

  it("classifies a 422 as DEFINITIVE, because retrying repeats the same rejection", async () => {
    const { transport } = transportWith(jsonResponse({ message: "invalid from" }, 422));

    const error = await transport.send(ENVELOPE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as MailTransportError).retryable).toBe(false);
    expect((error as MailTransportError).status).toBe(422);
  });

  it.each([429, 500, 503])("classifies %s as retryable", async (status) => {
    const { transport } = transportWith(jsonResponse({ message: "later" }, status));

    const error = await transport.send(ENVELOPE).catch((caught: unknown) => caught);

    expect((error as MailTransportError).retryable).toBe(true);
    expect((error as MailTransportError).status).toBe(status);
  });

  it("classifies a network failure as retryable and ambiguous", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const transport = createResendTransport({ apiKey: "re_test", fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await transport.send(ENVELOPE).catch((caught: unknown) => caught);

    expect((error as MailTransportError).retryable).toBe(true);
    expect((error as MailTransportError).message).toContain("socket hang up");
  });

  it("treats a 200 without a message id as retryable, not as success", async () => {
    // The email may have been delivered. Claiming failure would be a lie; the idempotency key
    // makes the retry a no-op, so retryable is the honest classification.
    const { transport } = transportWith(jsonResponse({ ok: true }));

    const error = await transport.send(ENVELOPE).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailTransportError);
    expect((error as MailTransportError).retryable).toBe(true);
    expect((error as MailTransportError).message).toContain("no message id");
  });

  it("refuses to construct without an API key", () => {
    expect(() => createResendTransport({ apiKey: "" })).toThrow(/API key/);
  });
});

describe("readResendConfig", () => {
  it("reads the key and a bare sender address", () => {
    expect(readResendConfig({ RESEND_API_KEY: "re_x", OUTBOUND_MAIL_FROM: "notifications@jobbeacon.in" })).toEqual({
      apiKey: "re_x",
      from: { name: null, address: "notifications@jobbeacon.in" },
    });
  });

  it("names the missing variable", () => {
    expect(() => readResendConfig({})).toThrow(/RESEND_API_KEY/);
  });

  it("refuses a sender that is not one bare address", () => {
    expect(() =>
      readResendConfig({ RESEND_API_KEY: "re_x", OUTBOUND_MAIL_FROM: "JobBeacon <notifications@jobbeacon.in>" }),
    ).toThrow(/single bare email address/);
    expect(() => readResendConfig({ RESEND_API_KEY: "re_x" })).toThrow(/OUTBOUND_MAIL_FROM/);
  });
});
