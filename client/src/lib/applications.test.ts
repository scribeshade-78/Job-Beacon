import { describe, expect, it, vi } from "vitest";
import { listApplications } from "./applications";

describe("listApplications", () => {
  it("maps plan rows, joined vacancy, and nested attempts on success", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-1",
          vacancy_id: "vac-1",
          gate_results: { eligible: true, gates: {} },
          created_at: "2026-08-18T00:00:00Z",
          vacancies: { raw_title: "Backend Engineer", authoritative_url: "https://example.com/jobs/1" },
          application_attempts: [
            {
              id: "attempt-1",
              status: "failed",
              attempts: 5,
              max_attempts: 5,
              last_error: "no submission adapter for this source",
              created_at: "2026-08-18T00:01:00Z",
              updated_at: "2026-08-18T00:05:00Z",
            },
          ],
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listApplications>[0];

    const result = await listApplications(client);

    expect(result).toEqual({
      kind: "success",
      applications: [
        {
          planId: "plan-1",
          vacancyId: "vac-1",
          vacancyTitle: "Backend Engineer",
          vacancyUrl: "https://example.com/jobs/1",
          eligible: true,
          createdAt: "2026-08-18T00:00:00Z",
          attempts: [
            {
              id: "attempt-1",
              status: "failed",
              attempts: 5,
              maxAttempts: 5,
              lastError: "no submission adapter for this source",
              createdAt: "2026-08-18T00:01:00Z",
              updatedAt: "2026-08-18T00:05:00Z",
            },
          ],
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("application_plans");
  });

  it("returns an ineligible plan with no attempts as an empty attempts array", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-2",
          vacancy_id: "vac-2",
          gate_results: { eligible: false, gates: {} },
          created_at: "2026-08-18T00:00:00Z",
          vacancies: { raw_title: "Data Analyst", authoritative_url: "https://example.com/jobs/2" },
          application_attempts: [],
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listApplications>[0];

    const result = await listApplications(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.applications[0].eligible).toBe(false);
      expect(result.applications[0].attempts).toEqual([]);
    }
  });

  it("falls back to empty vacancy fields when the join returns null", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-3",
          vacancy_id: "vac-3",
          gate_results: { eligible: false, gates: {} },
          created_at: "2026-08-18T00:00:00Z",
          vacancies: null,
          application_attempts: null,
        },
      ],
      error: null,
    });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listApplications>[0];

    const result = await listApplications(client);

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.applications[0].vacancyTitle).toBe("");
      expect(result.applications[0].vacancyUrl).toBe("");
      expect(result.applications[0].attempts).toEqual([]);
    }
  });

  it("returns a generic error and never the raw message on failure", async () => {
    const order = vi.fn().mockResolvedValue({ data: null, error: { message: "relation does not exist" } });
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listApplications>[0];

    const result = await listApplications(client);

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).not.toContain("relation");
    }
  });

  it("returns a generic error when the client throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network down");
    });
    const client = { from } as unknown as Parameters<typeof listApplications>[0];

    const result = await listApplications(client);

    expect(result).toEqual({ kind: "error", message: "Could not load your applications. Please try again." });
  });
});
