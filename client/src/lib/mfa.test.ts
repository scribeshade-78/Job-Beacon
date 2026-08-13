import { describe, expect, it, vi } from "vitest";
import { enrollTotp, listTotpFactors, unenrollFactor, verifyEnrollment } from "./mfa";

function createMfaClient(mfa: Record<string, ReturnType<typeof vi.fn>>) {
  return { auth: { mfa } } as unknown as Parameters<typeof enrollTotp>[0];
}

describe("enrollTotp", () => {
  it("returns the QR code and secret on success", async () => {
    const enroll = vi.fn().mockResolvedValue({
      data: { id: "factor-1", totp: { qr_code: "<svg/>", secret: "SECRET", uri: "otpauth://x" } },
      error: null,
    });
    const client = createMfaClient({ enroll });

    const result = await enrollTotp(client);

    expect(result).toEqual({
      kind: "success",
      enrollment: { factorId: "factor-1", qrCodeSvg: "<svg/>", secret: "SECRET" },
    });
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const enroll = vi.fn().mockResolvedValue({ data: null, error: { message: "factor limit reached, org 42" } });
    const client = createMfaClient({ enroll });

    const result = await enrollTotp(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("org 42");
    }
  });
});

describe("verifyEnrollment", () => {
  it("returns success when the code is correct", async () => {
    const challengeAndVerify = vi.fn().mockResolvedValue({ error: null });
    const client = createMfaClient({ challengeAndVerify });

    const result = await verifyEnrollment(client, "factor-1", "123456");

    expect(result).toEqual({ kind: "success" });
    expect(challengeAndVerify).toHaveBeenCalledWith({ factorId: "factor-1", code: "123456" });
  });

  it("returns a distinct invalid-code message when verification fails", async () => {
    const challengeAndVerify = vi.fn().mockResolvedValue({ error: { message: "invalid TOTP code" } });
    const client = createMfaClient({ challengeAndVerify });

    const result = await verifyEnrollment(client, "factor-1", "000000");

    expect(result).toEqual({ kind: "error", message: "That code didn't work. Please try again." });
  });
});

describe("unenrollFactor", () => {
  it("returns success on unenroll", async () => {
    const unenroll = vi.fn().mockResolvedValue({ error: null });
    const client = createMfaClient({ unenroll });

    const result = await unenrollFactor(client, "factor-1");

    expect(result).toEqual({ kind: "success" });
  });
});

describe("listTotpFactors", () => {
  it("maps factors on success", async () => {
    const listFactors = vi.fn().mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified", friendly_name: null }] },
      error: null,
    });
    const client = createMfaClient({ listFactors });

    const result = await listTotpFactors(client);

    expect(result).toEqual({
      kind: "success",
      factors: [{ id: "factor-1", status: "verified", friendlyName: null }],
    });
  });

  it("includes unverified factors — only data.totp is verified-only, data.all has everything", async () => {
    const listFactors = vi.fn().mockResolvedValue({
      data: { all: [{ id: "factor-2", factor_type: "totp", status: "unverified", friendly_name: null }] },
      error: null,
    });
    const client = createMfaClient({ listFactors });

    const result = await listTotpFactors(client);

    expect(result).toEqual({
      kind: "success",
      factors: [{ id: "factor-2", status: "unverified", friendlyName: null }],
    });
  });

  it("excludes non-totp factor types", async () => {
    const listFactors = vi.fn().mockResolvedValue({
      data: {
        all: [
          { id: "factor-1", factor_type: "totp", status: "verified", friendly_name: null },
          { id: "factor-3", factor_type: "phone", status: "verified", friendly_name: null },
        ],
      },
      error: null,
    });
    const client = createMfaClient({ listFactors });

    const result = await listTotpFactors(client);

    expect(result).toEqual({
      kind: "success",
      factors: [{ id: "factor-1", status: "verified", friendlyName: null }],
    });
  });
});
