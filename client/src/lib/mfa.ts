import type { SupabaseClient } from "@supabase/supabase-js";

const GENERIC_FAILURE_MESSAGE = "Could not update your two-factor authentication. Please try again.";
const INVALID_CODE_MESSAGE = "That code didn't work. Please try again.";

type MfaClient = Pick<SupabaseClient, "auth">;

export interface TotpEnrollment {
  factorId: string;
  qrCodeSvg: string;
  secret: string;
}

export type EnrollTotpResult =
  | { kind: "success"; enrollment: TotpEnrollment }
  | { kind: "error"; message: string };

/** Starts TOTP enrollment (PRD 6, 8, 25.1). The factor is `unverified` until verifyEnrollment succeeds. */
export async function enrollTotp(client: MfaClient): Promise<EnrollTotpResult> {
  try {
    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp" });

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      enrollment: {
        factorId: data.id,
        qrCodeSvg: data.totp.qr_code,
        secret: data.totp.secret,
      },
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export type VerifyTotpResult = { kind: "success" } | { kind: "error"; message: string };

/**
 * Completes enrollment by verifying a code from the candidate's
 * authenticator app. Supabase promotes the session to AAL2 and signs out
 * all other sessions on success (PRD 25.1: MFA/AAL2, session revocation).
 */
export async function verifyEnrollment(
  client: MfaClient,
  factorId: string,
  code: string,
): Promise<VerifyTotpResult> {
  try {
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId, code });

    if (error) {
      return { kind: "error", message: INVALID_CODE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export type UnenrollResult = { kind: "success" } | { kind: "error"; message: string };

export async function unenrollFactor(client: MfaClient, factorId: string): Promise<UnenrollResult> {
  try {
    const { error } = await client.auth.mfa.unenroll({ factorId });

    if (error) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return { kind: "success" };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export interface TotpFactorSummary {
  id: string;
  status: "verified" | "unverified";
  friendlyName: string | null;
}

export type ListTotpFactorsResult =
  | { kind: "success"; factors: TotpFactorSummary[] }
  | { kind: "error"; message: string };

export async function listTotpFactors(client: MfaClient): Promise<ListTotpFactorsResult> {
  try {
    const { data, error } = await client.auth.mfa.listFactors();

    if (error || !data) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    // data.totp (confirmed via @supabase/auth-js source) only contains
    // *verified* factors — data.all is the only place an unverified
    // (in-progress) factor shows up, which callers need to detect and
    // clear a stale enrollment attempt.
    return {
      kind: "success",
      factors: data.all
        .filter((factor) => factor.factor_type === "totp")
        .map((factor) => ({
          id: factor.id,
          status: factor.status,
          friendlyName: factor.friendly_name ?? null,
        })),
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}
