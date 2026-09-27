# JobBeacon — Pricing Plans & Quotas

The commercial catalogue: four plans, four billing regions, and the quotas and
feature matrix that describe them.

## Where this is defined

| Artefact | Role |
|---|---|
| `shared/pricing.ts` | **The single source of truth.** Plan codes, tier order, region/currency pairs, prices in minor units, destination quotas, the feature matrix and the checkout lock notice. Imported by both the server and the client. |
| `supabase/migrations/20260927120000_pricing_plans.sql` | Seeds the database to match, and widens the two region/currency CHECK constraints for UK/GBP. |
| `shared/pricing.parity.test.ts` | Parses the migration and fails if the seeded prices or quotas disagree with the constants. This is what stops the pricing page and the checkout route from drifting apart. |
| `client/src/panels/BillingPanel.tsx` | The candidate-facing view. Renders from the constants, so it cannot show a price the database was not seeded with. |
| `client/src/pages/admin/UsersBillingSection.tsx` | The admin view. Reads the database, so it shows what is actually stored — including a plan limit that is `NULL`, which renders as `Not configured` and never as `Unlimited`. |

Money is stored and passed as **minor units** (paise, cents, pence) as integers.
`amount_minor = 0` is a real price for the Free plan, not a missing value.

## 1. Monthly price (by region / currency)

| Plan | India | US | UK | EU |
|---|---|---|---|---|
| Free | ₹0 | $0 | £0 | €0 |
| Starter | ₹499 | $19 | £12 | €15 |
| Pro | ₹999 | $39 | £25 | €32 |
| Power | ₹2,499 | $99 | £69 | €85 |

Minimum-unit values as seeded: Free `0/0/0/0`; Starter `49900/1900/1200/1500`;
Pro `99900/3900/2500/3200`; Power `249900/9900/6900/8500`.

## 2. Auto-apply per month (by job destination)

| Plan | India jobs | US jobs |
|---|---|---|
| Free | 0 | 0 |
| Starter | 30 | 80 |
| Pro | 100 | 300 |
| Power | 750 | 1,000 |

**Destination means where the job is, not where the candidate is.** The allowance
is not transferable: an unused India allowance does not become US allowance.

## 3. Features

| Feature | Free | Starter | Pro | Power |
|---|---|---|---|---|
| Resume + Profile + feed + paste/tailor + tracker | Yes | Yes | Yes | Yes |
| Inbox + Queue + company dossier | Yes | Yes | Yes | Yes |
| Reply drafts | Limited | Yes | Yes | Yes |
| Gmail connect | No | Yes | Yes | Yes |
| Auto-submit (Greenhouse) | No | Quota | Quota | Quota |
| Owner Control | — | — | — | Owner only |

These cells are **descriptive, not enforced**. `Owner Control` is the existing
`user_roles` concept; `Auto-submit (Greenhouse)` is gated by an installed
employer credential in `ats_credentials` plus the source policy, not by a plan
column; `Reply drafts: Limited` has no numeric dimension yet. Nothing in the
feature matrix is read by an authorization decision.

## 4. Checkout lock

> Checkout locked. You are on Power. Razorpay (IN) + Stripe (US/UK/EU) after
> certification only.

Rendered verbatim on the candidate Plans & Billing page, with the plan name
substituted for the candidate's actual plan. Checkout buttons are present but
**disabled**; nothing on that page calls `/api/billing/checkout-session`.

The server routes remain fully implemented and tested (Stripe is wired and
returns 503 when unconfigured), so unbolting checkout is a UI change and a
deliberate decision rather than new integration work.

**The Free plan is refused by the checkout route with HTTP 400**, checked on the
amount rather than the plan code, so a zero-price plan can never create a payment
provider session.

## 5. Deviations and known gaps

- **GBP is a departure from the PRD.** PRD v3 §27.1 names INR, USD and EUR. The
  UK/GBP column is a later founder decision, recorded here and in the migration
  comment rather than absorbed silently. Both region/currency CHECK constraints
  were widened for exactly `(UK, GBP)`; no other pair became legal.
- **Annual billing was removed.** The `year` rows were seeded unpriced and never
  given a figure, so they were deleted rather than left to render as a permanent
  "Not priced". The `billing_interval` CHECK still allows `year`, so annual can
  return without a constraint change.
- **"No subscription" is the Free plan.** A candidate with no live
  `subscriptions` row is shown as Free, and entitlement evaluation treats an
  unconfigured dimension as permissive. No Free row is created for them.
- **Per-destination usage is not measured yet.** `candidate_entitlement_usage`
  counts applications globally, so the two auto-apply quotas are reported as
  configured allowances with `usage: null` rather than a fabricated "0 of 30
  used". Giving them a usage split is the next step if these are to be enforced.
- **`concierge` was renamed to `power`**, not deleted, so any subscription
  already pointing at it kept its foreign key and simply became Power. Verified
  against PostgreSQL 17 before the migration was applied.

## Naming

This file is the canonical pricing document. If a `VETRA_PRICING_PLANS.md` is
ever expected by another process, point it at this file rather than copying the
tables into a second document — two copies of a price list is precisely the drift
`shared/pricing.parity.test.ts` exists to prevent.
