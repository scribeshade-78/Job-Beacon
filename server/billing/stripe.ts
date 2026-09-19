import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Task H1 — Stripe, over plain fetch rather than the stripe SDK.
 *
 * Same convention server/mailbox/oauth.ts and server/companies/mcaRegistry.ts
 * already follow: a stable REST API with three or four well-documented calls
 * does not justify a multi-megabyte SDK, and the fetch shape keeps the whole
 * integration injectable, so every branch below is tested without a network.
 *
 * NOTHING HERE INVENTS A PAYMENT. With no STRIPE_SECRET_KEY configured every
 * entry point returns not_configured and the caller answers 503. There is no
 * fake checkout URL, because a fabricated URL would send a real candidate to a
 * page that cannot take their money.
 */

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Tolerated clock skew when validating a webhook timestamp, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeConfig {
  secretKey: string;
  /** Null when the webhook endpoint has not been registered in Stripe yet — the webhook route answers 503 rather than trusting anything. */
  webhookSecret: string | null;
}

/** Returns null, rather than throwing, so a deployment without billing boots normally. */
export function readStripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

  return { secretKey, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null };
}

export interface CheckoutSessionRequest {
  planCode: string;
  planDisplayName: string;
  /** Minor units (paise / cents), straight from regional_prices.amount_minor. */
  amountMinor: number;
  region: string;
  currency: string;
  billingInterval: "month" | "year";
  candidateId: string;
  successUrl: string;
  cancelUrl: string;
}

export type CheckoutSessionResult =
  | { kind: "created"; sessionId: string; url: string }
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

/**
 * Creates a Stripe Checkout Session in subscription mode.
 *
 * price_data rather than a pre-created Stripe Price id, deliberately: our
 * regional_prices table is the source of truth for what a plan costs in each
 * region, and mirroring it into Stripe Price objects would create a second
 * place for the price to live that can silently disagree with the first. An
 * inline price is a real Stripe capability and keeps the two in step by
 * construction.
 */
export async function createCheckoutSession(
  config: StripeConfig | null,
  request: CheckoutSessionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSessionResult> {
  if (!config) {
    return { kind: "not_configured" };
  }

  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", request.currency.toLowerCase());
  body.set("line_items[0][price_data][unit_amount]", String(request.amountMinor));
  body.set("line_items[0][price_data][recurring][interval]", request.billingInterval);
  body.set("line_items[0][price_data][product_data][name]", "JobBeacon " + request.planDisplayName);
  body.set("success_url", request.successUrl);
  body.set("cancel_url", request.cancelUrl);
  // client_reference_id is what lets the webhook tie the session back to a
  // candidate without trusting anything the browser sent us later.
  body.set("client_reference_id", request.candidateId);
  body.set("metadata[candidate_id]", request.candidateId);
  body.set("metadata[plan_code]", request.planCode);
  // Region, currency and interval ride along in metadata for the same reason as
  // plan_code: the webhook has to record WHICH price was bought, and reading it
  // back out of a Stripe amount would mean inferring it. A session that carries
  // its own metadata cannot be mis-attributed.
  body.set("metadata[region]", request.region);
  body.set("metadata[currency]", request.currency);
  body.set("metadata[billing_interval]", request.billingInterval);

  let response: Response;
  try {
    response = await fetchImpl(STRIPE_API_BASE + "/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch {
    return { kind: "error", message: "Could not reach Stripe." };
  }

  if (!response.ok) {
    return { kind: "error", message: "Stripe rejected the checkout session request (HTTP " + response.status + ")." };
  }

  let parsed: { id?: unknown; url?: unknown };
  try {
    parsed = (await response.json()) as { id?: unknown; url?: unknown };
  } catch {
    return { kind: "error", message: "Stripe returned a response that could not be read." };
  }

  if (typeof parsed.id !== "string" || typeof parsed.url !== "string") {
    return { kind: "error", message: "Stripe returned a session without an id or url." };
  }

  return { kind: "created", sessionId: parsed.id, url: parsed.url };
}

/**
 * Verifies a Stripe-Signature header.
 *
 * Implemented rather than stubbed because a webhook that accepts unverified
 * input is worse than no webhook at all: the body of this endpoint is "this
 * candidate now has a paid plan", so anything that can POST to it could grant
 * itself one. Fails closed on every malformed input.
 *
 * The signed payload is the timestamp, a literal dot, then the raw request body
 * — which is why the route must see the body as a Buffer. Once express.json()
 * has parsed it the original bytes are gone and no signature can be checked;
 * see the rawBody capture in server/index.ts.
 */
export function verifyStripeSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(",").map((part) => part.trim());
  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) {
    return false;
  }

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const toleranceSeconds = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  // Replay window. Without it a captured request stays valid forever.
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(timestamp + "." + payload).digest();

  for (const candidate of signatures) {
    let provided: Buffer;
    try {
      provided = Buffer.from(candidate, "hex");
    } catch {
      continue;
    }
    // timingSafeEqual throws on a length mismatch, so lengths are compared first.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }

  return false;
}
