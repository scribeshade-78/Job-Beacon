import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createCheckoutSession,
  readStripeConfig,
  STRIPE_API_BASE,
  verifyStripeSignature,
} from "./stripe.js";

/**
 * Signature verification is the only thing standing between the public webhook
 * route and "anyone who can POST to it may grant themselves a paid plan", so it
 * is tested against hand-built headers rather than only the happy path.
 */
function sign(payload: string, secret: string, timestamp: number): string {
  const signature = createHmac("sha256", secret).update(timestamp + "." + payload).digest("hex");
  return "t=" + String(timestamp) + ",v1=" + signature;
}

const SECRET = "whsec_test";
const NOW = 1_800_000_000;
const PAYLOAD = JSON.stringify({ type: "checkout.session.completed" });

describe("readStripeConfig", () => {
  it("returns null when no secret key is set, so billing is simply absent", () => {
    expect(readStripeConfig({})).toBeNull();
  });

  it("reports a null webhook secret rather than treating it as an empty string", () => {
    const config = readStripeConfig({ STRIPE_SECRET_KEY: "sk_test" });
    expect(config).toEqual({ secretKey: "sk_test", webhookSecret: null });
  });
});

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed payload", () => {
    expect(verifyStripeSignature(PAYLOAD, sign(PAYLOAD, SECRET, NOW), SECRET, { nowSeconds: NOW })).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyStripeSignature(PAYLOAD, undefined, SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyStripeSignature(PAYLOAD, sign(PAYLOAD, "whsec_other", NOW), SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("rejects a payload that was altered after signing", () => {
    const header = sign(PAYLOAD, SECRET, NOW);
    expect(verifyStripeSignature(PAYLOAD + " ", header, SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const header = sign(PAYLOAD, SECRET, NOW);
    expect(verifyStripeSignature(PAYLOAD, header, SECRET, { nowSeconds: NOW + 3600 })).toBe(false);
  });

  it("accepts a timestamp inside the tolerance window", () => {
    const header = sign(PAYLOAD, SECRET, NOW);
    expect(verifyStripeSignature(PAYLOAD, header, SECRET, { nowSeconds: NOW + 60 })).toBe(true);
  });

  it("rejects a header with no v1 part", () => {
    expect(verifyStripeSignature(PAYLOAD, "t=" + String(NOW), SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifyStripeSignature(PAYLOAD, "t=soon,v1=abc", SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("rejects a malformed header rather than throwing", () => {
    expect(verifyStripeSignature(PAYLOAD, "garbage", SECRET, { nowSeconds: NOW })).toBe(false);
    expect(verifyStripeSignature(PAYLOAD, "=", SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("accepts the signature when Stripe sends several v1 values", () => {
    const good = sign(PAYLOAD, SECRET, NOW);
    const header = good + ",v1=deadbeef";
    expect(verifyStripeSignature(PAYLOAD, header, SECRET, { nowSeconds: NOW })).toBe(true);
  });

  it("does not throw on a hex value of the wrong length", () => {
    // timingSafeEqual throws when lengths differ; the length check must come first.
    expect(verifyStripeSignature(PAYLOAD, "t=" + String(NOW) + ",v1=ab", SECRET, { nowSeconds: NOW })).toBe(false);
  });
});

describe("createCheckoutSession", () => {
  const request = {
    planCode: "pro",
    planDisplayName: "Pro",
    amountMinor: 249900,
    region: "IN",
    currency: "INR",
    billingInterval: "month" as const,
    candidateId: "cand-1",
    successUrl: "https://app.test/#/billing?checkout=success",
    cancelUrl: "https://app.test/#/billing?checkout=cancelled",
  };

  it("reports not_configured instead of inventing a URL when there is no key", async () => {
    const fetchImpl = vi.fn();
    const result = await createCheckoutSession(null, request, fetchImpl as never);
    expect(result).toEqual({ kind: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts a subscription-mode session carrying the region and plan in metadata", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" }),
    }));

    const result = await createCheckoutSession({ secretKey: "sk_test", webhookSecret: null }, request, fetchImpl as never);

    expect(result).toEqual({ kind: "created", sessionId: "cs_1", url: "https://checkout.stripe.test/cs_1" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe(STRIPE_API_BASE + "/checkout/sessions");
    const body = init.body;
    // Form-encoded, so the nested line_items keys arrive percent-escaped.
    // Asserting the escaped form is the point: it proves the nesting Stripe
    // requires is actually there rather than flattened into keys Stripe ignores.
    expect(body).toContain("mode=subscription");
    expect(body).toContain("line_items%5B0%5D%5Bquantity%5D=1");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=249900");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=inr");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month");
    expect(body).toContain("metadata%5Bregion%5D=IN");
    expect(body).toContain("metadata%5Bplan_code%5D=pro");
    expect(body).toContain("client_reference_id=cand-1");
  });

  it("reports an error rather than a URL when Stripe refuses", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) }));
    const result = await createCheckoutSession({ secretKey: "sk_test", webhookSecret: null }, request, fetchImpl as never);
    expect(result.kind).toBe("error");
  });

  it("reports an error when Stripe returns a session with no url", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "cs_1" }) }));
    const result = await createCheckoutSession({ secretKey: "sk_test", webhookSecret: null }, request, fetchImpl as never);
    expect(result).toEqual({ kind: "error", message: "Stripe returned a session without an id or url." });
  });

  it("reports an error rather than throwing when the network fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createCheckoutSession({ secretKey: "sk_test", webhookSecret: null }, request, fetchImpl as never);
    expect(result).toEqual({ kind: "error", message: "Could not reach Stripe." });
  });
});
