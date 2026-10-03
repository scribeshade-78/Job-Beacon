import { describe, expect, it, vi } from "vitest";
import {
  MAX_REPORT_DESCRIPTION_LENGTH,
  REPORT_CATEGORIES,
  isReportCategory,
  submitVacancyReport,
} from "./vacancyReports";

/**
 * The report client is a thin INSERT, so these tests pin the two things a thin
 * client can get wrong: the exact payload the schema's CHECK and RLS policies
 * see, and the fact that no database message ever reaches the candidate.
 */

interface InsertedRow {
  vacancy_id?: unknown;
  reporter_id?: unknown;
  category?: unknown;
  description?: unknown;
}

function fakeClient(options: { error?: { message: string } | null; throw?: boolean } = {}) {
  const inserted: InsertedRow[] = [];

  const client = {
    from: (table: string) => {
      expect(table).toBe("vacancy_reports");

      return {
        insert: async (row: InsertedRow) => {
          if (options.throw) {
            throw new Error("network down");
          }

          inserted.push(row);
          return { error: options.error ?? null };
        },
      };
    },
  };

  return { client: client as never, inserted };
}

describe("REPORT_CATEGORIES", () => {
  it("mirrors the CHECK constraint on vacancy_reports.category", () => {
    expect([...REPORT_CATEGORIES]).toEqual([
      "fake_job",
      "payment_request",
      "impersonation",
      "salary_mismatch",
      "expired_job",
      "misleading_remote_status",
    ]);
  });

  it("recognises only declared categories", () => {
    expect(isReportCategory("fake_job")).toBe(true);
    expect(isReportCategory("not_a_category")).toBe(false);
    expect(isReportCategory(undefined)).toBe(false);
  });
});

describe("submitVacancyReport", () => {
  it("inserts the reporter, vacancy and category the RLS WITH CHECK requires", async () => {
    const { client, inserted } = fakeClient();

    const result = await submitVacancyReport(client, "candidate-1", "job-1", "expired_job", "Still listed.");

    expect(result).toEqual({ kind: "success" });
    expect(inserted).toEqual([
      {
        vacancy_id: "job-1",
        reporter_id: "candidate-1",
        category: "expired_job",
        description: "Still listed.",
      },
    ]);
  });

  it("stores a blank description as null rather than an empty string", async () => {
    const { client, inserted } = fakeClient();

    await submitVacancyReport(client, "candidate-1", "job-1", "fake_job", "   ");

    expect(inserted[0]?.description).toBeNull();
  });

  it("caps an over-long description at the limit", async () => {
    const { client, inserted } = fakeClient();

    await submitVacancyReport(client, "candidate-1", "job-1", "fake_job", "x".repeat(MAX_REPORT_DESCRIPTION_LENGTH + 500));

    expect((inserted[0]?.description as string).length).toBe(MAX_REPORT_DESCRIPTION_LENGTH);
  });

  it("returns the generic sentence, never the database message, on a write error", async () => {
    const { client } = fakeClient({ error: { message: 'duplicate key value violates unique constraint "vacancy_reports_pkey"' } });

    const result = await submitVacancyReport(client, "candidate-1", "job-1", "fake_job", null);

    expect(result).toEqual({ kind: "error", message: "Could not send your report. Please try again." });
    expect(JSON.stringify(result)).not.toContain("constraint");
  });

  it("returns the generic sentence when the client throws", async () => {
    const { client } = fakeClient({ throw: true });

    const result = await submitVacancyReport(client, "candidate-1", "job-1", "fake_job", null);

    expect(result).toEqual({ kind: "error", message: "Could not send your report. Please try again." });
  });
});
