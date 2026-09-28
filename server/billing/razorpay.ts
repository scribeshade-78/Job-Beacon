import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Task R5 — Razorpay, over plain fetch rather than the razorpay SDK.
 *
 * Same convention server/billing/stripe.ts, server/mailbox/oauth.ts and
 * server/companies/mcaRegistry.ts already follow: a handful of well-documented
 * REST calls does not justify an SDK, and the fetch shape keeps every branch
 * injectable so the tests never touch the network.
 *
 * NOTHING HERE INVENTS A PAYMENT. With no credentials configured every entry
 * point returns not_configured and the caller answers 503. There is deliberately
 * no fabricated order id: an order the provider never issued would send a real
 * candidate to a Checkout that cannot take their money.
 *
 * WHY RAZORPAY EXISTS ALONGSIDE STRIPE RATHER THAN REPLACING IT. PRD v3 §27.1
 * prices India in INR and the founder's earlier product used Razorpay, which is
 * India-first: international cards require activation. Stripe stays the provider
 * for US/UK/EU. The two are not alternatives, they are one provider per region,
 * and the region decides which one a candidate is offered.
 */

export const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

export interface RazorpayConfig {
  /** The PUBLISHABLE key id. Safe to hand to the browser — Checkout needs it. */
  keyId: string;
  /** The secret. Never leaves the server: it both authenticates the API and signs the callback. */
  keySecret: string;
  /** Null until the endpoint is registered in the Razorpay dashboard; the webhook route answers 503 rather than trusting anything. */
  webhookSecret: string | null;
}

/**
 * Returns null rather than throwing, so a deployment without billing boots
 * normally. BOTH halves are required: a key id with no secret cannot sign a
 * request, and a secret with no id cannot authenticate one.
 */
export function readRazorpayConfig(env: Record<string, string | undefined> = process.env): RazorpayConfig | null {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return null;
  }

  return { keyId, keySecret, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? null };
}

export interface RazorpayOrderRequest {
  planCode: string;
  planDisplayName: string;
  /** Minor units (paise), straight from regional_prices.amount_minor. Razorpay takes paise, so no conversion. */
  amountMinor: number;
  currency: string;
  region: string;
  billingInterval: "month" | "year";
  candidateId: string;
}

export type RazorpayOrderResult =
  | { kind: "created"; orderId: string; amountMinor: number; currency: string; keyId: string }
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

/**
 * Creates a Razorpay Order.
 *
 * THE NOTES ARE THE WHOLE POINT. Razorpay copies an order's notes onto the
 * payment entity, so the webhook can read back WHICH candidate and WHICH plan
 * this money was for. Reconstructing that from the amount would mean inferring
 * it — several regions share a price, and a plan's price can change — and a
 * mis-attributed payment is a paid plan granted to the wrong person. An order
 * that carries its own metadata cannot be mis-attributed.
 *
 * Receipt is capped at 40 characters by Razorpay, so it is derived rather than
 * built from the candidate id, which alone is 36.
 */
export async function createRazorpayOrder(
  config: RazorpayConfig | null,
  request: RazorpayOrderRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayOrderResult> {
  if (!config) {
    return { kind: "not_configured" };
  }

  const body = JSON.stringify({
    amount: request.amountMinor,
    currency: request.currency,
    receipt: "jb-" + request.planCode + "-" + Date.now().toString(36),
    notes: {
      candidate_id: request.candidateId,
      plan_code: request.planCode,
      region: request.region,
      currency: request.currency,
      billing_interval: request.billingInterval,
    },
  });

  let response: Response;

  try {
    response = await fetchImpl(RAZORPAY_API_BASE + "/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(config.keyId + ":" + config.keySecret).toString("base64"),
        "Content-Type": "application/json",
      },
      body,
    });
  } catch {
    return { kind: "error", message: "Could not reach Razorpay." };
  }

  if (!response.ok) {
    return { kind: "error", message: "Razorpay rejected the order request (HTTP " + response.status + ")." };
  }

  let parsed: { id?: unknown; amount?: unknown; currency?: unknown };

  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    return { kind: "error", message: "Razorpay returned a response that could not be read." };
  }

  if (typeof parsed.id !== "string" || parsed.id === "") {
    return { kind: "error", message: "Razorpay returned an order without an id." };
  }

  return {
    kind: "created",
    orderId: parsed.id,
    amountMinor: typeof parsed.amount === "number" ? parsed.amount : request.amountMinor,
    currency: typeof parsed.currency === "string" ? parsed.currency : request.currency,
    keyId: config.keyId,
  };
}

/** Constant-time hex-signature comparison, shared by both verification paths. */
function signaturesMatch(expected: Buffer, providedHex: string): boolean {
  let provided: Buffer;

  try {
    provided = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, so lengths are compared first.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Verifies the checkout callback.
 *
 * Razorpay's documented scheme for the browser handshake: the signature is
 * HMAC-SHA256 of "order_id|payment_id" under the KEY SECRET. This is what
 * prevents a forged success — the browser hands back an order id and a payment
 * id, and without this check anything that can POST to the verify route could
 * claim a payment that never happened.
 *
 * Fails closed on every malformed input, including a non-hex signature.
 */
export function verifyRazorpayCallbackSignature(
  orderId: string,
  paymentId: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(orderId + "|" + paymentId).digest();

  return signaturesMatch(expected, signature);
}

/**
 * Verifies an X-Razorpay-Signature header.
 *
 * The signed payload is the RAW request body under the WEBHOOK SECRET, which is
 * why the route must be registered with express.raw() ahead of express.json():
 * once the JSON parser has consumed the stream the original bytes are gone and
 * no signature can be checked. Same ordering constraint as the Stripe webhook.
 *
 * NO TIMESTAMP TOLERANCE, UNLIKE STRIPE. Razorpay does not put a timestamp in
 * the header, so there is no replay window to enforce — a captured request stays
 * valid. The mitigations are that the body alone grants nothing (the handler
 * still has to resolve a real candidate and plan) and that re-applying an event
 * is idempotent, because applyCheckoutCompleted updates the candidate's existing
 * live row rather than inserting a second one.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();

  return signaturesMatch(expected, signatureHeader);
}

export interface RazorpayOrderDetails {
  orderId: string;
  amountMinor: number;
  currency: string;
  status: string;
  /** The notes we set at creation, as Razorpay stored them. */
  notes: Record<string, string>;
}

export type RazorpayOrderFetchResult =
  | { kind: "found"; order: RazorpayOrderDetails }
  | { kind: "error"; message: string };

/**
 * Reads an order back from Razorpay.
 *
 * THIS IS WHAT STOPS PLAN SUBSTITUTION. The checkout callback signature covers
 * "order_id|payment_id" — it says nothing about WHICH PLAN was bought. Without
 * this lookup a candidate could create an order for Starter (INR 499), pay it,
 * and then call the verify route naming Power: the signature would still be
 * valid, because it is over the order and payment ids, and the server would
 * grant the top plan for the price of the entry one.
 *
 * So the plan, the region and the currency are read from the ORDER the provider
 * actually issued — which we labelled with notes at creation — and never from
 * the request body. The candidate id in those notes is checked against the
 * verified caller too, so one candidate cannot claim another's paid order.
 */
export async function fetchRazorpayOrder(
  config: RazorpayConfig | null,
  orderId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayOrderFetchResult> {
  if (!config) {
    return { kind: "error", message: "Razorpay is not configured." };
  }

  let response: Response;

  try {
    response = await fetchImpl(RAZORPAY_API_BASE + "/orders/" + encodeURIComponent(orderId), {
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(config.keyId + ":" + config.keySecret).toString("base64"),
      },
    });
  } catch {
    return { kind: "error", message: "Could not reach Razorpay." };
  }

  if (!response.ok) {
    return { kind: "error", message: "Razorpay could not return that order (HTTP " + response.status + ")." };
  }

  let parsed: { id?: unknown; amount?: unknown; currency?: unknown; status?: unknown; notes?: unknown };

  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    return { kind: "error", message: "Razorpay returned a response that could not be read." };
  }

  if (typeof parsed.id !== "string") {
    return { kind: "error", message: "Razorpay returned an order without an id." };
  }

  const rawNotes = (parsed.notes ?? {}) as Record<string, unknown>;
  const notes: Record<string, string> = {};

  for (const [key, value] of Object.entries(rawNotes)) {
    if (typeof value === "string") {
      notes[key] = value;
    }
  }

  return {
    kind: "found",
    order: {
      orderId: parsed.id,
      amountMinor: typeof parsed.amount === "number" ? parsed.amount : 0,
      currency: typeof parsed.currency === "string" ? parsed.currency : "",
      status: typeof parsed.status === "string" ? parsed.status : "",
      notes,
    },
  };
}
