import { describe, expect, it, vi } from "vitest";
import { listSalaryBenchmarks, listVerifiedCompanies } from "./companyIntelligence";

describe("listVerifiedCompanies", () => {
  it("maps company rows with joined profile and legal entities on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "company-1",
          displayed_name: "Applyco",
          domain: "applyco.example",
          career_domain: "careers.applyco.example",
          company_profiles: {
            headquarters_country: "IN",
            operating_countries: ["IN", "US"],
            industry: "Software",
            founded_year: 2015,
            employee_size_range: "51-200",
            public_private_status: "private",
          },
          company_legal_entities: [
            {
              id: "entity-1",
              jurisdiction: "IN",
              registry_identifier: "U72900MH2015PTC123456",
              legal_name: "Applyco Private Limited",
              registration_status: "Active",
              company_class: "Private",
            },
          ],
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listVerifiedCompanies>[0];

    const result = await listVerifiedCompanies(client);

    expect(result).toEqual({
      kind: "success",
      companies: [
        {
          companyId: "company-1",
          displayedName: "Applyco",
          domain: "applyco.example",
          careerDomain: "careers.applyco.example",
          profile: {
            headquartersCountry: "IN",
            operatingCountries: ["IN", "US"],
            industry: "Software",
            foundedYear: 2015,
            employeeSizeRange: "51-200",
            publicPrivateStatus: "private",
          },
          legalEntities: [
            {
              id: "entity-1",
              jurisdiction: "IN",
              registryIdentifier: "U72900MH2015PTC123456",
              legalName: "Applyco Private Limited",
              registrationStatus: "Active",
              companyClass: "Private",
            },
          ],
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("companies");
  });

  it("returns an empty legalEntities array when a company has none", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "company-2",
          displayed_name: "Bareco",
          domain: null,
          career_domain: null,
          company_profiles: {
            headquarters_country: null,
            operating_countries: null,
            industry: null,
            founded_year: null,
            employee_size_range: null,
            public_private_status: null,
          },
          company_legal_entities: null,
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listVerifiedCompanies>[0];

    const result = await listVerifiedCompanies(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.companies[0].legalEntities).toEqual([]);
    }
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listVerifiedCompanies>[0];

    const result = await listVerifiedCompanies(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listVerifiedCompanies>[0];

    const result = await listVerifiedCompanies(client);

    expect(result).toEqual({
      kind: "error",
      message: "Could not load verified company profiles. Please try again.",
    });
  });
});

describe("listSalaryBenchmarks", () => {
  it("maps benchmark rows on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "benchmark-1",
          role_label: "Backend Engineer",
          region: "IN",
          currency: "INR",
          salary_interval: "year",
          salary_min: 800000,
          salary_max: 1800000,
          benchmark_source: "India Labour Bureau",
          effective_date: "2026-07-01",
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listSalaryBenchmarks>[0];

    const result = await listSalaryBenchmarks(client);

    expect(result).toEqual({
      kind: "success",
      benchmarks: [
        {
          id: "benchmark-1",
          roleLabel: "Backend Engineer",
          region: "IN",
          currency: "INR",
          salaryInterval: "year",
          salaryMin: 800000,
          salaryMax: 1800000,
          benchmarkSource: "India Labour Bureau",
          effectiveDate: "2026-07-01",
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("salary_benchmarks");
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listSalaryBenchmarks>[0];

    const result = await listSalaryBenchmarks(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listSalaryBenchmarks>[0];

    const result = await listSalaryBenchmarks(client);

    expect(result).toEqual({ kind: "error", message: "Could not load salary benchmarks. Please try again." });
  });
});
