import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_ATTEMPT_STATUSES,
  ATTEMPT_STATUS_LABELS,
  listApplications,
} from "./applications";

describe("ATTEMPT_STATUS_LABELS", () => {
  it("labels every status, so no lifecycle state renders as a raw database token", () => {
    // The panel falls back to the raw status, which is tolerable for a missing
    // label only if someone notices. This is what makes adding a status without
    // a label fail here instead of in front of a candidate.
    for (const status of APPLICATION_ATTEMPT_STATUSES) {
      expect(ATTEMPT_STATUS_LABELS[status]).toBeTruthy();
    }

    expect(Object.keys(ATTEMPT_STATUS_LABELS).sort()).toEqual([...APPLICATION_ATTEMPT_STATUSES].sort());
  });

  it("gives the review hold a label that says what the candidate is expected to do", () => {
    expect(ATTEMPT_STATUS_LABELS.pending_review).toBe("Awaiting your review");
  });

  it("distinguishes a status from the one next to it rather than repeating a word", () => {
    // 'pending' and 'pending_review' differ only by whether the candidate has
    // to act, which is exactly the distinction the labels must carry.
    expect(ATTEMPT_STATUS_LABELS.pending).not.toBe(ATTEMPT_STATUS_LABELS.pending_review);
  });
});

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
          companyName: null,
          eligible: true,
          createdAt: "2026-08-18T00:00:00Z",
          // No messages embedded on this row, so no response stages — and,
          // importantly, NOT 'rejection': the attempt is 'failed', which means
          // the submission worker could not send it, not that the employer
          // turned the candidate down.
          responseCategories: [],
          attempts: [
            {
              id: "attempt-1",
              status: "failed",
              attempts: 5,
              maxAttempts: 5,
              lastError: "no submission adapter for this source",
              createdAt: "2026-08-18T00:01:00Z",
              updatedAt: "2026-08-18T00:05:00Z",
              // No evidence row on this attempt: a 'failed' status with nothing
              // captured must render as no evidence, not as an absent field.
              evidence: [],
            },
          ],
        },
      ],
    });
    expect(from).toHaveBeenCalledWith("application_plans");
  });

  it("requests the three-level embed down to response classifications", async () => {
    const order = vi.fn().mockResolvedValue({ data: [], error: null });
    // Declared with its parameter so calls[0][0] is typed as the column string.
    const select = vi.fn((_columns: string) => ({ order }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Parameters<typeof listApplications>[0];

    await listApplications(client);

    const columns = select.mock.calls[0][0];
    expect(columns).toContain("application_attempts");
    expect(columns).toContain("messages");
    expect(columns).toContain("response_classifications");
    // Evidence and the employer name travel on the same read: the evidence view
    // has nothing to show without the first, and the second is the destination
    // the evidence refers to.
    expect(columns).toContain("application_evidence");
    expect(columns).toContain("companies");
  });

  it("reduces evidence rows to safe view models on the attempt", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-5",
          vacancy_id: "vac-5",
          gate_results: { eligible: true },
          created_at: "2026-08-18T00:00:00Z",
          vacancies: {
            raw_title: "Platform Engineer",
            authoritative_url: "https://example.com/jobs/5",
            companies: { displayed_name: "Acme" },
          },
          application_attempts: [
            {
              id: "attempt-5",
              status: "succeeded",
              attempts: 1,
              max_attempts: 5,
              last_error: null,
              created_at: "2026-08-18T00:01:00Z",
              updated_at: "2026-08-18T00:05:00Z",
              application_evidence: [
                {
                  id: "ev-1",
                  evidence_type: "greenhouse_submission",
                  payload: { applicationId: 99, endpoint: "https://internal.example.com/x" },
                  captured_at: "2026-08-18T00:05:00Z",
                },
              ],
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

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      const attempt = result.applications[0].attempts[0];

      expect(result.applications[0].companyName).toBe("Acme");
      expect(attempt.evidence).toHaveLength(1);
      expect(attempt.evidence[0].kind).toBe("submission");
      // The disclosure boundary holds all the way through the mapping.
      expect(JSON.stringify(attempt.evidence)).not.toContain("internal.example.com");
    }
  });

  it("derives response categories from the classifications reachable through its attempts", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-4",
          vacancy_id: "vac-4",
          gate_results: { eligible: true },
          created_at: "2026-08-18T00:00:00Z",
          vacancies: { raw_title: "Data Engineer", authoritative_url: "https://example.com/jobs/4" },
          application_attempts: [
            {
              id: "attempt-4",
              status: "succeeded",
              attempts: 1,
              max_attempts: 5,
              last_error: null,
              created_at: "2026-08-18T00:01:00Z",
              updated_at: "2026-08-18T00:05:00Z",
              messages: [
                { response_classifications: [{ category: "interview" }] },
                { response_classifications: [{ category: "interview" }] },
                { response_classifications: [] },
                { response_classifications: null },
              ],
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

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      // Deduplicated across messages, and null/empty embeds contribute nothing.
      expect(result.applications[0].responseCategories).toEqual(["interview"]);
    }
  });

  it("drops a response category this bundle does not recognise", async () => {
    // response_classifications.category has no CHECK constraint, so a newer
    // taxonomy can write a value this build has no stage chip for.
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: "plan-5",
          vacancy_id: "vac-5",
          gate_results: { eligible: true },
          created_at: "2026-08-18T00:00:00Z",
          vacancies: null,
          application_attempts: [
            {
              id: "attempt-5",
              status: "succeeded",
              attempts: 1,
              max_attempts: 5,
              last_error: null,
              created_at: "2026-08-18T00:01:00Z",
              updated_at: "2026-08-18T00:05:00Z",
              messages: [{ response_classifications: [{ category: "coding_challenge" }, { category: "offer" }] }],
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

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.applications[0].responseCategories).toEqual(["offer"]);
    }
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
