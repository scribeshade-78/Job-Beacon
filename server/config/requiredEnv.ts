import type { HealthEnvKey } from "../../shared/app.js";

/**
 * Brief 3 - the single list of what the app needs to serve, and what it merely wants.
 *
 * WHY A LIST AND NOT A SCATTER OF process.env READS. "Which keys are required" was
 * folklore: discoverable only by reading every module that reads one, and by
 * remembering which outage followed which omission. One reviewed list makes it
 * answerable in one place, and it is what /api/health reports and what
 * deploy/assert-environment.sh asserts against.
 *
 * REQUIRED IS DELIBERATELY NARROW. A key belongs here only if the app cannot serve
 * a single request without it. Marking a feature key required would fail every
 * deploy while that feature is legitimately unconfigured - Razorpay is ABSENT BY
 * DESIGN until checkout is switched on - and a gate that cries wolf gets disabled
 * by hand, which is worse than no gate at all.
 */

export interface EnvRequirement {
  name: string;
  /** What stops working without it. Reported so an operator reading the JSON knows the cost. */
  consequence: string;
}

export const REQUIRED_ENV: readonly EnvRequirement[] = [
  {
    name: "SUPABASE_URL",
    consequence: "No database, auth or storage. Every route fails.",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    consequence: "The server cannot read or write any table. Every route fails.",
  },
];

export const OPTIONAL_ENV: readonly EnvRequirement[] = [
  {
    name: "OPENROUTER_API_KEY",
    consequence:
      "Resume tailoring and cover-letter generation are unavailable, and the scheduler refuses to start.",
  },
  {
    name: "RAZORPAY_KEY_ID",
    consequence: "India checkout cannot create an order; the early-access plan switch is offered instead.",
  },
  {
    name: "RAZORPAY_KEY_SECRET",
    consequence: "Razorpay order verification fails, so no India payment can be confirmed.",
  },
  {
    name: "STRIPE_SECRET_KEY",
    consequence: "US, UK and EU checkout cannot start; the early-access plan switch is offered instead.",
  },
  {
    name: "ATS_CREDENTIAL_ENCRYPTION_KEY",
    consequence: "Greenhouse and Lever credentials cannot be decrypted, so ingestion from them cannot run.",
  },
];

export interface EnvReport {
  ok: boolean;
  requiredMissing: string[];
  optionalMissing: string[];
  keys: HealthEnvKey[];
}

/**
 * AN EMPTY STRING COUNTS AS ABSENT. .env files carry bare `NAME=` lines, so both
 * `"NAME" in process.env` and `process.env.NAME !== undefined` would report a
 * present-but-empty key as configured. This is the check that would have caught a
 * half-written .env.build before a deploy rather than after.
 */
function isPresent(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function inspectEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const keys: HealthEnvKey[] = [
    ...REQUIRED_ENV.map((entry) => ({ ...entry, required: true, present: isPresent(env[entry.name]) })),
    ...OPTIONAL_ENV.map((entry) => ({ ...entry, required: false, present: isPresent(env[entry.name]) })),
  ];

  const requiredMissing = keys.filter((key) => key.required && !key.present).map((key) => key.name);
  const optionalMissing = keys.filter((key) => !key.required && !key.present).map((key) => key.name);

  return { ok: requiredMissing.length === 0, requiredMissing, optionalMissing, keys };
}
