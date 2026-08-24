import { describe, expect, it, vi } from "vitest";
import {
  getCompanyReviewSummary,
  listCompaniesForReview,
  submitCompanyReview,
  type ReviewRatings,
} from "./companyReviews";

const ratings: ReviewRatings = { workLifeBalance: 4, compensation: 3, managementAndCulture: 5, careerGrowth: 4 };

describe("listCompaniesForReview", () => {
  it("returns all companies, mapped to camelCase, ordered by name", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [{ id: "company-1", displayed_name: "Acme Corp" }],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listCompaniesForReview>[0];

    const result = await listCompaniesForReview(client);

    expect(result).toEqual({ kind: "success", companies: [{ id: "company-1", displayedName: "Acme Corp" }] });
    expect(from).toHaveBeenCalledWith("companies");
  });

  it("returns a generic error on a query failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listCompaniesForReview>[0];

    const result = await listCompaniesForReview(client);

    expect(result.kind).toBe("error");
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    const result = await listCompaniesForReview({ from } as unknown as Parameters<typeof listCompaniesForReview>[0]);

    expect(result.kind).toBe("error");
  });
});

describe("submitCompanyReview", () => {
  it("inserts the review with the snake_case column names", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof submitCompanyReview>[0];

    const result = await submitCompanyReview(client, "company-1", "candidate-1", ratings, "Great team.");

    expect(result).toEqual({ kind: "success" });
    expect(insert).toHaveBeenCalledWith({
      company_id: "company-1",
      reviewer_id: "candidate-1",
      work_life_balance: 4,
      compensation: 3,
      management_and_culture: 5,
      career_growth: 4,
      review_text: "Great team.",
    });
  });

  it("returns duplicate, not success, on a unique-violation (23505) — a second submission's content would otherwise be silently discarded", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof submitCompanyReview>[0];

    const result = await submitCompanyReview(client, "company-1", "candidate-1", ratings, null);

    expect(result).toEqual({ kind: "duplicate" });
  });

  it("returns a generic error for a non-duplicate insert failure", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: "23514", message: "check constraint violation" } });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as Parameters<typeof submitCompanyReview>[0];

    const result = await submitCompanyReview(client, "company-1", "candidate-1", ratings, null);

    expect(result.kind).toBe("error");
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    const result = await submitCompanyReview(
      { from } as unknown as Parameters<typeof submitCompanyReview>[0],
      "company-1",
      "candidate-1",
      ratings,
      null,
    );

    expect(result.kind).toBe("error");
  });
});

function rowsFixture(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    work_life_balance: 4,
    compensation: 3,
    management_and_culture: 5,
    career_growth: index % 2 === 0 ? 4 : 2, // varies, so the average isn't trivially the same as a single row
  }));
}

describe("getCompanyReviewSummary", () => {
  it("reads company_reviews_public, never the base table", async () => {
    const eq = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0];

    await getCompanyReviewSummary(client, "company-1");

    expect(from).toHaveBeenCalledWith("company_reviews_public");
    expect(eq).toHaveBeenCalledWith("company_id", "company-1");
  });

  it("returns tier 'insufficient' and null averages for 0-4 reviews (PRD §14.4)", async () => {
    const eq = vi.fn().mockResolvedValue({ data: rowsFixture(4), error: null });
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const client = { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0];

    const result = await getCompanyReviewSummary(client, "company-1");

    expect(result).toEqual({ kind: "success", summary: { reviewCount: 4, tier: "insufficient", averages: null } });
  });

  it("returns tier 'low_confidence' with averages for 5-9 reviews", async () => {
    const eq = vi.fn().mockResolvedValue({ data: rowsFixture(5), error: null });
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const client = { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0];

    const result = await getCompanyReviewSummary(client, "company-1");

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.summary.tier).toBe("low_confidence");
      expect(result.summary.reviewCount).toBe(5);
      expect(result.summary.averages).not.toBeNull();
      expect(result.summary.averages?.workLifeBalance).toBe(4);
    }
  });

  it("returns tier 'confident' for 10-19 reviews", async () => {
    const eq = vi.fn().mockResolvedValue({ data: rowsFixture(10), error: null });
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const client = { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0];

    const result = await getCompanyReviewSummary(client, "company-1");

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.summary.tier).toBe("confident");
    }
  });

  it("returns tier 'prominent' for 20+ reviews", async () => {
    const eq = vi.fn().mockResolvedValue({ data: rowsFixture(20), error: null });
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const client = { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0];

    const result = await getCompanyReviewSummary(client, "company-1");

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.summary.tier).toBe("prominent");
    }
  });

  it("returns a generic error on a query failure", async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    const client = { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0];

    const result = await getCompanyReviewSummary(client, "company-1");

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("boom");
    });
    const result = await getCompanyReviewSummary(
      { from } as unknown as Parameters<typeof getCompanyReviewSummary>[0],
      "company-1",
    );

    expect(result.kind).toBe("error");
  });
});
