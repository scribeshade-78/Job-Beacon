import { describe, expect, it, vi } from "vitest";
import { fetchMcaCompanyByCin, McaRateLimitedError, McaRecordNotFoundError } from "./mcaRegistry.js";

// Fixture shape is a best-effort guess from the R5.3 spike's secondary
// sources — NOT verified against a live API response (data.gov.in's
// catalog page returned HTTP 403 during that spike). These tests prove
// parseMcaRecord's own transformation logic given this shape; they do
// not prove the shape itself is correct.
const fixtureResponse = {
  records: [
    {
      CIN: "U72900MH2015PTC123456",
      COMPANY_NAME: "Applyco Private Limited",
      COMPANY_STATUS: "Active",
      DATE_OF_REGISTRATION: "2015-04-01",
      COMPANY_CATEGORY: "Company limited by Shares",
      COMPANY_CLASS: "Private",
      AUTHORIZED_CAP: 5000000,
      PAIDUP_CAPITAL: 3200000,
      REGISTERED_STATE: "Maharashtra",
      ROC_CODE: "RoC-Mumbai",
    },
  ],
};

function fixtureFetch(status = 200, body: unknown = fixtureResponse) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

const credentials = { apiKey: "test-api-key", resourceId: "test-resource-id" };

describe("fetchMcaCompanyByCin", () => {
  it("throws a config-boundary error and never calls fetch when credentials are missing", async () => {
    const fetchImpl = fixtureFetch();

    await expect(fetchMcaCompanyByCin("U72900MH2015PTC123456", { apiKey: "", resourceId: "" }, fetchImpl)).rejects.toThrow(
      /apiKey and resourceId/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requests the resource endpoint with the api key, format, and CIN filter as query params", async () => {
    const fetchImpl = fixtureFetch();

    await fetchMcaCompanyByCin("U72900MH2015PTC123456", credentials, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.data.gov.in/resource/test-resource-id?api-key=test-api-key&format=json&filters%5BCIN%5D=U72900MH2015PTC123456",
      { headers: { Accept: "application/json" } },
    );
  });

  it("normalizes a matched record into McaCompanyRecord shape", async () => {
    const result = await fetchMcaCompanyByCin("U72900MH2015PTC123456", credentials, fixtureFetch());

    expect(result).toEqual({
      cin: "U72900MH2015PTC123456",
      legalName: "Applyco Private Limited",
      registrationStatus: "Active",
      registrationDate: "2015-04-01",
      companyCategory: "Company limited by Shares",
      companyClass: "Private",
      authorizedCapital: 5000000,
      paidUpCapital: 3200000,
      registeredRegion: "Maharashtra",
      registrar: "RoC-Mumbai",
      raw: fixtureResponse.records[0],
    });
  });

  it("throws McaRateLimitedError on HTTP 429", async () => {
    await expect(
      fetchMcaCompanyByCin("U72900MH2015PTC123456", credentials, fixtureFetch(429, {})),
    ).rejects.toBeInstanceOf(McaRateLimitedError);
  });

  it("throws a clear error on a non-2xx, non-429 response", async () => {
    await expect(fetchMcaCompanyByCin("U72900MH2015PTC123456", credentials, fixtureFetch(500, {}))).rejects.toThrow(
      /500/,
    );
  });

  it("throws McaRecordNotFoundError when the response has no matching record", async () => {
    await expect(
      fetchMcaCompanyByCin("U00000000000000000000", credentials, fixtureFetch(200, { records: [] })),
    ).rejects.toBeInstanceOf(McaRecordNotFoundError);
  });

  it("throws McaRecordNotFoundError when the response has no records field at all", async () => {
    await expect(
      fetchMcaCompanyByCin("U00000000000000000000", credentials, fixtureFetch(200, {})),
    ).rejects.toBeInstanceOf(McaRecordNotFoundError);
  });

  it("throws a clear error on a malformed record missing CIN or COMPANY_NAME", async () => {
    await expect(
      fetchMcaCompanyByCin(
        "U72900MH2015PTC123456",
        credentials,
        fixtureFetch(200, { records: [{ COMPANY_STATUS: "Active" }] }),
      ),
    ).rejects.toThrow(/Unexpected MCA record shape/);
  });
});
