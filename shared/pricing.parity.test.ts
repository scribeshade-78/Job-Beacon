import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BILLING_REGIONS,
  PLAN_CATALOGUE,
  PLAN_CODES,
  REGION_CURRENCY,
  FEATURE_MATRIX,
  type PlanCode,
} from "./pricing.js";

/**
 * The catalogue and the seed migration are two files that must agree, and this
 * is the only thing standing between them and silent drift.
 *
 * WHY PARSE SQL IN A TEST. The alternative is trusting that whoever changes a
 * price remembers both places, and the cost of forgetting is a pricing page that
 * shows £25 while the checkout route charges something else. The migration marks
 * its two value lists with PARITY-BLOCK comments and keeps one tuple per line so
 * this can read them; reformat those lists and the test fails loudly rather than
 * silently comparing nothing.
 */
// Resolved from the project root rather than import.meta.url: these tests run
// under the jsdom environment, where import.meta.url is an http: URL (Vite serves
// the module) and readFileSync rejects anything that is not a file: URL.
const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260927120000_pricing_plans.sql",
);

/**
 * The weekly prices are NOT in MIGRATION_PATH, and cannot be: 20260927120000
 * predates the CHECK that allows billing_interval = 'week', so inserting them
 * there fails with a constraint violation on a fresh replay. They live in the
 * migration that widens the CHECK. Resolving a path per block is what lets each
 * list sit where it is legal while still being compared against the catalogue.
 */
const WEEKLY_PRICES_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20261010000000_billing_interval_week.sql",
);

function parityBlock(name: string, path: string = MIGRATION_PATH): string {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("-- PARITY-BLOCK:" + name + "-BEGIN");
  const end = text.indexOf("-- PARITY-BLOCK:" + name + "-END");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("parity block missing or malformed in the migration: " + name);
  }

  return text.slice(start, end);
}

describe("shared/pricing.ts is internally consistent", () => {
  it("declares a catalogue entry for every plan code, in tier order", () => {
    expect(PLAN_CATALOGUE.map((plan) => plan.code)).toEqual([...PLAN_CODES]);
  });

  it("gives every plan a price for every region, and a distinct increasing tier", () => {
    for (const plan of PLAN_CATALOGUE) {
      for (const region of BILLING_REGIONS) {
        expect(typeof plan.monthlyPriceMinor[region]).toBe("number");
      }
    }

    const ranks = PLAN_CATALOGUE.map((plan) => plan.tierRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(Math.min(...ranks)).toBeGreaterThan(0);
  });

  it("keeps quotas non-decreasing up the tiers", () => {
    const india = PLAN_CATALOGUE.map((plan) => plan.autoApplyPerMonth.india);
    const us = PLAN_CATALOGUE.map((plan) => plan.autoApplyPerMonth.us);
    expect(india).toEqual([...india].sort((a, b) => a - b));
    expect(us).toEqual([...us].sort((a, b) => a - b));
  });

  it("gives every feature row a cell for every plan", () => {
    for (const row of FEATURE_MATRIX) {
      for (const code of PLAN_CODES) {
        expect(typeof row.values[code as PlanCode]).toBe("string");
      }
    }
  });

  it("pairs each region with the currency the database CHECK allows", () => {
    expect(REGION_CURRENCY).toEqual({ IN: "INR", US: "USD", UK: "GBP", EU: "EUR" });
  });
});

describe("the seed migration matches the catalogue", () => {
  it("seeds exactly one price per plan per region, with the catalogue's amount", () => {
    const tuples = [...parityBlock("PRICES").matchAll(/\(\s*'([a-z]+)',\s*'([A-Z]{2})',\s*'([A-Z]{3})',\s*(\d+)\s*\)/g)].map(
      (match) => ({
        code: match[1],
        region: match[2],
        currency: match[3],
        amountMinor: Number(match[4]),
      }),
    );

    const expected = PLAN_CATALOGUE.flatMap((plan) =>
      BILLING_REGIONS.map((region) => ({
        code: plan.code,
        region,
        currency: REGION_CURRENCY[region],
        amountMinor: plan.monthlyPriceMinor[region],
      })),
    );

    expect(tuples).toHaveLength(expected.length);

    for (const row of expected) {
      expect(tuples).toContainEqual(row);
    }
  });

  /**
   * The weekly matrix. A separate block rather than a second tuple field in
   * PRICES, because the existing block is verified and its regexp is positional —
   * adding an interval column to it would rewrite the sixteen tuples that already
   * agree with the catalogue, for no gain.
   */
  it("seeds the weekly matrix from weeklyPriceMinor", () => {
    const tuples = [...parityBlock("WEEKLY-PRICES", WEEKLY_PRICES_PATH).matchAll(/\(\s*'([a-z]+)',\s*'([A-Z]{2})',\s*'([A-Z]{3})',\s*(\d+)\s*\)/g)].map(
      (match) => ({
        code: match[1],
        region: match[2],
        currency: match[3],
        amountMinor: Number(match[4]),
      }),
    );

    const expected = PLAN_CATALOGUE.flatMap((plan) =>
      BILLING_REGIONS.map((region) => ({
        code: plan.code,
        region,
        currency: REGION_CURRENCY[region],
        amountMinor: plan.weeklyPriceMinor[region],
      })),
    );

    expect(tuples).toHaveLength(expected.length);

    for (const row of expected) {
      expect(tuples).toContainEqual(row);
    }
  });

  it("seeds exactly the catalogue's quota values", () => {
    const tuples = [...parityBlock("QUOTAS").matchAll(/\(\s*'([a-z]+)',\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/g)].map(
      (match) => ({
        code: match[1],
        india: Number(match[2]),
        us: Number(match[3]),
        verified: Number(match[4]),
        mailboxes: Number(match[5]),
      }),
    );

    const expected = PLAN_CATALOGUE.map((plan) => ({
      code: plan.code,
      india: plan.autoApplyPerMonth.india,
      us: plan.autoApplyPerMonth.us,
      verified: plan.verifiedApplicationsPerMonth,
      mailboxes: plan.maxMailboxConnections,
    }));

    expect(tuples).toHaveLength(expected.length);

    for (const row of expected) {
      expect(tuples).toContainEqual(row);
    }
  });
});