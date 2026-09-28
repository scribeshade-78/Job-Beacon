/**
 * Razorpay Checkout, loaded on demand.
 *
 * THE SCRIPT IS FETCHED WHEN A CANDIDATE ACTUALLY CLICKS PAY, not on page load.
 * A pricing page has no business pulling a payment provider's bundle for every
 * visitor who is only reading, and the script is a third-party origin.
 *
 * The key id and the order id arrive from the server per order. Nothing here
 * decides what is being bought: the amount and currency are the ones the server
 * put on the order, and the plan is read back out of that order server-side when
 * the callback is verified. This module only collects the three fields Razorpay
 * hands the browser and passes them on to be checked.
 */

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
const SCRIPT_ID = "razorpay-checkout-script";

interface RazorpayHandlerResponse {
  razorpay_payment_id?: unknown;
  razorpay_order_id?: unknown;
  razorpay_signature?: unknown;
}

interface RazorpayInstance {
  open(): void;
}

interface RazorpayConstructor {
  new (options: Record<string, unknown>): RazorpayInstance;
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

/** Resolves false rather than throwing when the script cannot load — an ad blocker or an offline browser is a normal state, not a crash. */
export function loadRazorpayCheckout(doc: Document = document): Promise<boolean> {
  if (typeof window !== "undefined" && window.Razorpay) {
    return Promise.resolve(true);
  }

  const existing = doc.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

  if (existing) {
    return new Promise((resolve) => {
      existing.addEventListener("load", () => resolve(Boolean(window.Razorpay)));
      existing.addEventListener("error", () => resolve(false));
    });
  }

  return new Promise((resolve) => {
    const script = doc.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    doc.body.appendChild(script);
  });
}

export type RazorpayCheckoutOutcome =
  | { kind: "paid"; paymentId: string; orderId: string; signature: string }
  | { kind: "dismissed" }
  | { kind: "unavailable"; message: string };

export interface RazorpayCheckoutOptions {
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  planName: string;
  email?: string | null;
}

export async function openRazorpayCheckout(
  options: RazorpayCheckoutOptions,
  deps: { doc?: Document } = {},
): Promise<RazorpayCheckoutOutcome> {
  const doc = deps.doc ?? document;
  const loaded = await loadRazorpayCheckout(doc);

  if (!loaded || !window.Razorpay) {
    return {
      kind: "unavailable",
      message: "Could not load the payment window. Check your connection and try again.",
    };
  }

  return new Promise<RazorpayCheckoutOutcome>((resolve) => {
    // Razorpay can fire the handler and then ondismiss (or neither), so only the
    // first outcome counts. Without this the modal closing after a successful
    // payment would report a cancellation over the top of a real one.
    let settled = false;
    const settle = (outcome: RazorpayCheckoutOutcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    const instance = new window.Razorpay!({
      key: options.keyId,
      amount: options.amountMinor,
      currency: options.currency,
      name: "JobBeacon",
      description: options.planName,
      order_id: options.orderId,
      prefill: options.email ? { email: options.email } : undefined,
      theme: { color: "#2563eb" },
      handler: (response: RazorpayHandlerResponse) => {
        if (
          typeof response.razorpay_order_id === "string" &&
          typeof response.razorpay_payment_id === "string" &&
          typeof response.razorpay_signature === "string"
        ) {
          settle({
            kind: "paid",
            orderId: response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          });
          return;
        }

        settle({ kind: "unavailable", message: "Razorpay returned an incomplete confirmation." });
      },
      modal: { ondismiss: () => settle({ kind: "dismissed" }) },
    });

    instance.open();
  });
}
