import { describe, expect, it, vi } from "vitest";
import { submitVacancyReport } from "./reports.js";

function makeClient(result: { data: unknown; error: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain = (method: string) => (...args: unknown[]) => (calls.push({ method, args }), builder);
  const builder = {
    calls,
    insert: chain("insert"),
    select: chain("select"),
    single: (...args: unknown[]) => (calls.push({ method: "single", args }), result),
  };
  const from = vi.fn(() => builder);
  const client = { from } as unknown as Parameters<typeof submitVacancyReport>[0];

  return { client, from, calls };
}

describe("submitVacancyReport", () => {
  it("inserts a report with the given reporterId and returns its id", async () => {
    const { client, from, calls } = makeClient({ data: { id: "report-1" }, error: null });

    const result = await submitVacancyReport(client, {
      vacancyId: "vacancy-1",
      reporterId: "reporter-1",
      category: "payment_request",
      description: "Asked for a fee.",
    });

    expect(result).toEqual({ id: "report-1" });
    expect(from).toHaveBeenCalledWith("vacancy_reports");
    expect(calls[0]).toEqual({
      method: "insert",
      args: [
        {
          vacancy_id: "vacancy-1",
          reporter_id: "reporter-1",
          category: "payment_request",
          description: "Asked for a fee.",
        },
      ],
    });
  });

  it("defaults description to null when omitted", async () => {
    const { client, calls } = makeClient({ data: { id: "report-1" }, error: null });

    await submitVacancyReport(client, {
      vacancyId: "vacancy-1",
      reporterId: "reporter-1",
      category: "fake_job",
    });

    expect((calls[0].args[0] as { description: unknown }).description).toBeNull();
  });

  it("throws when the insert errors", async () => {
    const { client } = makeClient({ data: null, error: { message: "insert failed" } });
    await expect(
      submitVacancyReport(client, {
        vacancyId: "vacancy-1",
        reporterId: "reporter-1",
        category: "fake_job",
      }),
    ).rejects.toBeTruthy();
  });
});
