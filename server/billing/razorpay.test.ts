import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRazorpayOrder,
  fetchRazorpayOrder,
  readRazorpayConfig,
  verifyRazorpayCallbackSignature,
  verifyRazorpayWebhookSignature,
  type RazorpayConfig,
} from "./razorpay.js";

const CONFIG: RazorpayConfig = {
  keyId: "rzp_test_key",
  keySecret: "test_secret",
  webhookSecret: "whsec_test",
};

const ORDER_REQUEST = {
  planCode: "starter",
  planDisplayName: "Starter",
  amountMinor: 49900,
  currency: "INR",
  region: "IN",
  billingInterval: "month" as const,
  candidateId: "user-123",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function hmacHex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("readRazorpayConfig", () => {
  it("returns null when either half is missing", () => {
    expect(readRazorpayConfig({})).toBeNull();
    expect(readRazorpayConfig({ RAZORPAY_KEY_ID: "rzp_test_key" })).toBeNull();
    expect(readRazorpayConfig({ RAZORPAY_KEY_SECRET: "secret" })).toBeNull();
    expect(readRazorpayConfig({ RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "secret" })).toBeNull();
  });

  it("returns the config with a null webhook secret when only the webhook is unset", () => {
    const config = readRazorpayConfig({ RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "secret" });

    expect(config).toEqual({ keyId: "rzp_test_key", keySecret: "secret", webhookSecret: null });
  });

  it("reads the webhook secret when present", () => {
    const config = readRazorpayConfig({
      RAZORPAY_KEY_ID: "rzp_test_key",
      RAZORPAY_KEY_SECRET: "secret",
      RAZORPAY_WEBHOOK_SECRET: "whsec",
    });

    expect(config?.webhookSecret).toBe("whsec");
  });
});

describe("createRazorpayOrder", () => {
  it("reports not_configured rather than inventing an order", async () => {
    const fetchImpl = vi.fn();

    await expect(createRazorpayOrder(null, ORDER_REQUEST, fetchImpl as never)).resolves.toEqual({
      kind: "not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the paise amount and Basic auth to the orders endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_1", amount: 49900, currency: "INR" }));

    await createRazorpayOrder(CONFIG, ORDER_REQUEST, fetchImpl as never);

    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];

    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(init.method).toBe("POST");
    // Razorpay takes paise, and amountMinor is already paise — no conversion.
    expect(JSON.parse(init.body).amount).toBe(49900);
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("rzp_test_key:test_secret").toString("base64"),
    );
  });

  /**
   * THE METADATA IS THE SECURITY CONTROL. The webhook and the callback verifier
   * both read the plan back out of these notes, which is what stops a candidate
   * paying for Starter and claiming Power. If they stop being sent, the whole
   * substitution defence goes with them.
   */
  it("carries the candidate, plan, region and currency in the notes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_1" }));

    await createRazorpayOrder(CONFIG, ORDER_REQUEST, fetchImpl as never);

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, { body: string }])[1].body);

    expect(body.notes).toEqual({
      candidate_id: "user-123",
      plan_code: "starter",
      region: "IN",
      currency: "INR",
      billing_interval: "month",
    });
  });

  it("keeps the receipt inside Razorpay's 40-character limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_1" }));

    await createRazorpayOrder(CONFIG, ORDER_REQUEST, fetchImpl as never);

    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, { body: string }])[1].body);

    expect(body.receipt.length).toBeLessThanOrEqual(40);
  });

  it("returns the order id, amount, currency and the publishable key id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_1", amount: 49900, currency: "INR" }));

    await expect(createRazorpayOrder(CONFIG, ORDER_REQUEST, fetchImpl as never)).resolves.toEqual({
      kind: "created",
      orderId: "order_1",
      amountMinor: 49900,
      currency: "INR",
      keyId: "rzp_test_key",
    });
  });

  it("reports an error on a provider rejection, an unreadable body, or a missing id", async () => {
    const rejected = vi.fn().mockResolvedValue(jsonResponse(401, { error: "nope" }));
    const unreadable = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response);
    const noId = vi.fn().mockResolvedValue(jsonResponse(200, { amount: 49900 }));

    for (const impl of [rejected, unreadable, noId]) {
      const result = await createRazorpayOrder(CONFIG, ORDER_REQUEST, impl as never);
      expect(result.kind).toBe("error");
    }
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await createRazorpayOrder(CONFIG, ORDER_REQUEST, fetchImpl as never);

    expect(result).toEqual({ kind: "error", message: "Could not reach Razorpay." });
  });
});

describe("verifyRazorpayCallbackSignature", () => {
  it("accepts a correct HMAC over order_id|payment_id", () => {
    const signature = hmacHex("order_1|pay_1", CONFIG.keySecret);

    expect(verifyRazorpayCallbackSignature("order_1", "pay_1", signature, CONFIG.keySecret)).toBe(true);
  });

  it("rejects a wrong, absent or non-hex signature", () => {
    const good = hmacHex("order_1|pay_1", CONFIG.keySecret);

    expect(verifyRazorpayCallbackSignature("order_1", "pay_1", "deadbeef", CONFIG.keySecret)).toBe(false);
    expect(verifyRazorpayCallbackSignature("order_1", "pay_1", undefined, CONFIG.keySecret)).toBe(false);
    expect(verifyRazorpayCallbackSignature("order_1", "pay_1", "zzzz", CONFIG.keySecret)).toBe(false);
  });

  /**
   * THE PLAN-SUBSTITUTION TEST. A signature for one order must not validate a
   * different one, which is the half of that defence the signature can carry —
   * the other half is reading the plan back out of the order itself.
   */
  it("does not validate a different order or payment", () => {
    const signature = hmacHex("order_1|pay_1", CONFIG.keySecret);

    expect(verifyRazorpayCallbackSignature("order_2", "pay_1", signature, CONFIG.keySecret)).toBe(false);
    expect(verifyRazorpayCallbackSignature("order_1", "pay_2", signature, CONFIG.keySecret)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const signature = hmacHex("order_1|pay_1", "someone_elses_secret");

    expect(verifyRazorpayCallbackSignature("order_1", "pay_1", signature, CONFIG.keySecret)).toBe(false);
  });
});

describe("verifyRazorpayWebhookSignature", () => {
  it("accepts a correct HMAC over the raw body", () => {
    const body = JSON.stringify({ event: "payment.captured" });

    expect(verifyRazorpayWebhookSignature(body, hmacHex(body, "whsec_test"), "whsec_test")).toBe(true);
  });

  it("rejects a tampered body, an absent header and a non-hex header", () => {
    const body = JSON.stringify({ event: "payment.captured" });
    const signature = hmacHex(body, "whsec_test");

    expect(verifyRazorpayWebhookSignature(body + " ", signature, "whsec_test")).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, undefined, "whsec_test")).toBe(false);
    expect(verifyRazorpayWebhookSignature(body, "not-hex", "whsec_test")).toBe(false);
  });
});

describe("fetchRazorpayOrder", () => {
  it("returns the notes the order carries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        id: "order_1",
        amount: 49900,
        currency: "INR",
        status: "paid",
        notes: { candidate_id: "user-123", plan_code: "starter", region: "IN", currency: "INR" },
      }),
    );

    const result = await fetchRazorpayOrder(CONFIG, "order_1", fetchImpl as never);

    expect(result.kind).toBe("found");
    expect(result.kind === "found" && result.order.notes.plan_code).toBe("starter");
    expect(result.kind === "found" && result.order.notes.candidate_id).toBe("user-123");
  });

  it("drops non-string note values rather than trusting them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { id: "order_1", notes: { plan_code: "starter", amount: 49900, ok: null } }),
    );

    const result = await fetchRazorpayOrder(CONFIG, "order_1", fetchImpl as never);

    expect(result.kind === "found" && result.order.notes).toEqual({ plan_code: "starter" });
  });

  it("errors rather than returning a half-read order", async () => {
    const rejected = vi.fn().mockResolvedValue(jsonResponse(404, { error: "no such order" }));
    const noId = vi.fn().mockResolvedValue(jsonResponse(200, { amount: 1 }));
    const unreadable = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    } as unknown as Response);

    for (const impl of [rejected, noId, unreadable]) {
      expect((await fetchRazorpayOrder(CONFIG, "order_1", impl as never)).kind).toBe("error");
    }
  });

  it("errors when Razorpay is not configured", async () => {
    expect((await fetchRazorpayOrder(null, "order_1")).kind).toBe("error");
  });
});
