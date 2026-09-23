import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CandidateResolutionError,
  discoverLiveJobs,
  getCandidatePipeline,
  getOpportunityDetails,
  IntakeInputError,
  QueueApplicationsInputError,
  queueApplications,
  resolveCandidateId,
  VacancyNotFoundError,
} from "./tools.js";
import { PIPELINE_STAGES } from "../../shared/pipelineStages.js";

// queueApplications delegates to bulkApplyToVacancies; the engine's own
// behaviour is covered by server/applications/bulkApply.test.ts, so what is
// under test here is the delegation, the input validation, and the candidate
// resolution — not a second copy of the gate logic.
vi.mock("../applications/bulkApply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../applications/bulkApply.js")>();
  return { ...actual, bulkApplyToVacancies: vi.fn() };
});

import { bulkApplyToVacancies, MAX_BULK_APPLY_VACANCIES } from "../applications/bulkApply.js";

// discoverLiveJobs delegates to runIntake; the policy gating, ingestion and
// scoring are covered by server/intake/intake.test.ts. What is under test here
// is the MCP-facing surface: source resolution, input validation, and the shape
// (and honesty) of what an agent is told.
vi.mock("../intake/intake.js", () => ({
  runIntake: vi.fn(),
}));

import { runIntake } from "../intake/intake.js";

const mockedBulkApply = vi.mocked(bulkApplyToVacancies);
const mockedRunIntake = vi.mocked(runIntake);

/** Thenable chainable double. */
function thenable(result: { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in", "maybeSingle", "single"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (value: unknown) => void) => resolve(result);
  return builder;
}

/**
 * Queue of results per table, consumed one per from(table) call. Any WRITE
 * method throws, so these tests also pin the read-only boundary: if a tool
 * ever starts mutating, every test using this double fails loudly.
 */
function makeClient(queues: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const remaining: Record<string, Array<{ data?: unknown; error?: unknown }>> = Object.fromEntries(
    Object.entries(queues).map(([table, list]) => [table, [...list]]),
  );

  const from = vi.fn((table: string) => {
    const queue = remaining[table];
    if (!queue || queue.length === 0) throw new Error("unexpected from(" + table + ")");
    return thenable(queue.shift()!);
  });

  for (const write of ["insert", "update", "delete", "upsert", "rpc"]) {
    (from as unknown as Record<string, unknown>)[write] = () => {
      throw new Error("read-only violation: " + write + " was called");
    };
  }

  return { from } as unknown as SupabaseClient;
}

const CANDIDATE = "11111111-1111-4111-8111-111111111111";

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    vacancy_id: "vac-1",
    gate_results: { eligible: true, gates: {} },
    created_at: "2026-09-18T00:00:00Z",
    vacancies: { raw_title: "Data Engineer", authoritative_url: "https://example.test/1", trust_status: "VERIFIED", source_code: "jooble" },
    application_attempts: [],
    ...overrides,
  };
}

describe("resolveCandidateId", () => {
  it("returns the requested candidate when it exists", async () => {
    const client = makeClient({ candidate_profiles: [{ data: { id: CANDIDATE }, error: null }] });
    await expect(resolveCandidateId(client, CANDIDATE)).resolves.toBe(CANDIDATE);
  });

  it("rejects an explicit candidate_id that does not exist", async () => {
    const client = makeClient({ candidate_profiles: [{ data: null, error: null }] });
    await expect(resolveCandidateId(client, CANDIDATE)).rejects.toThrow(CandidateResolutionError);
  });

  it("defaults to the only candidate when candidate_id is omitted", async () => {
    const client = makeClient({ candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }] });
    await expect(resolveCandidateId(client)).resolves.toBe(CANDIDATE);
  });

  it("refuses to guess when several candidates exist", async () => {
    const client = makeClient({
      candidate_profiles: [{ data: [{ id: "a" }, { id: "b" }], error: null }],
    });

    await expect(resolveCandidateId(client)).rejects.toThrow(/candidate_id is required: 2 candidates exist/);
  });

  it("reports an empty database clearly", async () => {
    const client = makeClient({ candidate_profiles: [{ data: [], error: null }] });
    await expect(resolveCandidateId(client)).rejects.toThrow(/No candidate_profiles rows exist/);
  });
});

describe("getCandidatePipeline", () => {
  /**
   * A FRESH client per test. The double consumes one queued result per
   * from(table) call, so sharing one instance across tests would leave later
   * tests with an exhausted queue and fail for the wrong reason.
   */
  const pipelineClient = () =>
    makeClient({
    candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }],
    application_plans: [
      {
        data: [
          // succeeded attempt, no response -> Applied
          plan({
            id: "p1",
            application_attempts: [
              { id: "a1", status: "succeeded", attempts: 1, max_attempts: 5, last_error: null, messages: [] },
            ],
          }),
          plan({ id: "p2", application_attempts: [{ id: "a2", status: "pending", attempts: 0, max_attempts: 5, last_error: null, messages: [] }] }), // In Progress
          plan({
            id: "p3",
            application_attempts: [
              {
                id: "a3",
                status: "succeeded",
                attempts: 1,
                max_attempts: 5,
                last_error: null,
                messages: [{ response_classifications: [{ category: "interview" }] }],
              },
            ],
          }), // Interview
          plan({
            id: "p4",
            application_attempts: [
              {
                id: "a4",
                status: "succeeded",
                attempts: 1,
                max_attempts: 5,
                last_error: null,
                // interview AND rejection -> Rejection, by precedence
                messages: [
                  { response_classifications: [{ category: "interview" }] },
                  { response_classifications: [{ category: "rejection" }] },
                ],
              },
            ],
          }),
          plan({
            id: "p5",
            application_attempts: [
              {
                id: "a5",
                status: "failed",
                attempts: 5,
                max_attempts: 5,
                last_error: "boom",
                messages: [],
              },
            ],
          }), // In Progress, NOT Rejection
        ],
        error: null,
      },
    ],
    });

  it("returns every stage in chronological order, including empty ones", async () => {
    const result = await getCandidatePipeline(pipelineClient());

    expect(result.stages.map((stage) => stage.stage)).toEqual(PIPELINE_STAGES.map((stage) => stage.id));
    expect(result.stages).toHaveLength(6);
  });

  it("classifies each application into exactly one mutually exclusive stage", async () => {
    const result = await getCandidatePipeline(pipelineClient());
    const counts = Object.fromEntries(result.stages.map((stage) => [stage.stage, stage.count]));

    expect(counts).toEqual({ all: 5, in_progress: 2, applied: 1, interview: 1, offer: 0, rejection: 1 });
  });

  it("keeps the categorized counts summing exactly to All", async () => {
    const result = await getCandidatePipeline(pipelineClient());
    const summed = result.stages
      .filter((stage) => stage.stage !== "all")
      .reduce((total, stage) => total + stage.count, 0);

    expect(summed).toBe(result.totalApplications);
  });

  it("never classifies a failed submission as a rejection", async () => {
    const result = await getCandidatePipeline(pipelineClient());
    const rejection = result.stages.find((stage) => stage.stage === "rejection")!;
    const inProgress = result.stages.find((stage) => stage.stage === "in_progress")!;

    expect(rejection.applications.map((a) => a.planId)).toEqual(["p4"]);
    expect(inProgress.applications.map((a) => a.planId).sort()).toEqual(["p2", "p5"]);
  });

  it("surfaces the last error and the response categories", async () => {
    const result = await getCandidatePipeline(pipelineClient());
    const failed = result.stages.find((stage) => stage.stage === "in_progress")!.applications.find((a) => a.planId === "p5")!;

    expect(failed.lastError).toBe("boom");
    expect(failed.attempts).toEqual([{ status: "failed" }]);
  });

  it("returns an all-zero pipeline when the candidate has no applications", async () => {
    const empty = makeClient({
      candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }],
      application_plans: [{ data: [], error: null }],
    });

    const result = await getCandidatePipeline(empty);

    expect(result.totalApplications).toBe(0);
    expect(result.stages.every((stage) => stage.count === 0)).toBe(true);
  });
});

describe("getOpportunityDetails", () => {
  it("returns the full vacancy row, its company, and the blocking gates", async () => {
    const client = makeClient({
      candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }],
      vacancies: [{ data: { id: "vac-1", raw_title: "Data Engineer", trust_status: "VERIFIED", source_code: "jooble", company_id: "co-1" }, error: null }],
      companies: [{ data: { id: "co-1", displayed_name: "Acme" }, error: null }],
      application_plans: [
        {
          data: {
            id: "plan-1",
            gate_results: {
              eligible: false,
              gates: {
                source_policy: { status: "pass" },
                application_support: { status: "fail", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" },
                vacancy_trust: { status: "fail", reasonCode: "VACANCY_TRUST_STATUS_INELIGIBLE" },
              },
            },
          },
          error: null,
        },
      ],
      application_attempts: [{ data: [{ id: "a1", status: "pending", attempts: 0, max_attempts: 5, last_error: null }], error: null }],
    });

    const result = await getOpportunityDetails(client, { vacancyId: "vac-1" });

    expect(result.vacancy).toMatchObject({ id: "vac-1", trust_status: "VERIFIED" });
    expect(result.company).toMatchObject({ displayed_name: "Acme" });
    expect(result.plan?.eligible).toBe(false);
    expect(result.plan?.blockingGates).toEqual([
      { gate: "application_support", reasonCode: "NO_ADAPTER_REGISTERED_FOR_SOURCE" },
      { gate: "vacancy_trust", reasonCode: "VACANCY_TRUST_STATUS_INELIGIBLE" },
    ]);
    expect(result.attempts).toEqual([{ id: "a1", status: "pending", attempts: 0, maxAttempts: 5, lastError: null }]);
  });

  it("explains the absence of gates when no plan exists", async () => {
    const client = makeClient({
      candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }],
      vacancies: [{ data: { id: "vac-2", company_id: null }, error: null }],
      application_plans: [{ data: null, error: null }],
    });

    const result = await getOpportunityDetails(client, { vacancyId: "vac-2" });

    expect(result.plan).toBeNull();
    expect(result.company).toBeNull();
    expect(result.planNote).toMatch(/No application_plans row/);
  });

  it("throws a specific error for an unknown vacancy", async () => {
    const client = makeClient({
      candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }],
      vacancies: [{ data: null, error: null }],
    });

    await expect(getOpportunityDetails(client, { vacancyId: "missing" })).rejects.toThrow(VacancyNotFoundError);
  });
});

describe("queueApplications", () => {
  beforeEach(() => {
    mockedBulkApply.mockReset();
  });

  const emptyResult = { requested: 1, queued: 0, blocked: 1, errors: 0, outcomes: [] };

  it("delegates to bulkApplyToVacancies and returns its outcome unchanged", async () => {
    mockedBulkApply.mockResolvedValueOnce(emptyResult);
    const client = makeClient({ candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }] });

    const result = await queueApplications(client, { vacancyIds: ["vac-1"] });

    expect(mockedBulkApply).toHaveBeenCalledWith(client, { candidateId: CANDIDATE, vacancyIds: ["vac-1"] });
    expect(result).toBe(emptyResult);
  });

  it("passes an explicit candidate_id through instead of resolving one", async () => {
    mockedBulkApply.mockResolvedValueOnce(emptyResult);
    const other = "22222222-2222-4222-8222-222222222222";
    const client = makeClient({ candidate_profiles: [{ data: { id: other }, error: null }] });

    await queueApplications(client, { vacancyIds: ["vac-1"], candidateId: other });

    expect(mockedBulkApply).toHaveBeenCalledWith(client, { candidateId: other, vacancyIds: ["vac-1"] });
  });

  it("refuses an empty vacancy_ids list without touching the engine", async () => {
    const client = makeClient({});

    await expect(queueApplications(client, { vacancyIds: [] })).rejects.toThrow(QueueApplicationsInputError);
    expect(mockedBulkApply).not.toHaveBeenCalled();
  });

  it("refuses more ids than the shared HTTP limit", async () => {
    const client = makeClient({});
    const tooMany = Array.from({ length: MAX_BULK_APPLY_VACANCIES + 1 }, (_, index) => "v" + index);

    await expect(queueApplications(client, { vacancyIds: tooMany })).rejects.toThrow(
      new RegExp("at most " + MAX_BULK_APPLY_VACANCIES),
    );
    expect(mockedBulkApply).not.toHaveBeenCalled();
  });

  it("accepts exactly the limit", async () => {
    mockedBulkApply.mockResolvedValueOnce(emptyResult);
    const exactly = Array.from({ length: MAX_BULK_APPLY_VACANCIES }, (_, index) => "v" + index);
    const client = makeClient({ candidate_profiles: [{ data: [{ id: CANDIDATE }], error: null }] });

    await queueApplications(client, { vacancyIds: exactly });

    expect(mockedBulkApply).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue when the candidate cannot be resolved", async () => {
    const client = makeClient({ candidate_profiles: [{ data: [{ id: "a" }, { id: "b" }], error: null }] });

    await expect(queueApplications(client, { vacancyIds: ["vac-1"] })).rejects.toThrow(CandidateResolutionError);
    expect(mockedBulkApply).not.toHaveBeenCalled();
  });
});

describe("discoverLiveJobs", () => {
  const intakeResult = {
    sourceCode: "remotive",
    displayName: "Remotive (public remote-job API)",
    attribution: "Job data from Remotive (https://remotive.com), delayed by 24 hours.",
    search: "data engineer",
    received: 12,
    skippedByAdapter: 2,
    ingested: 10,
    trustStatusCounts: { VERIFIED_INCOMPLETE: 10 },
    outcomes: [
      { vacancyId: "vac-1", title: "Senior Data Engineer", companyName: "Acme", outcome: "created", trustStatus: "VERIFIED_INCOMPLETE" },
    ],
    durationMs: 840,
  };

  beforeEach(() => {
    mockedRunIntake.mockReset();
    mockedRunIntake.mockResolvedValue(intakeResult as never);
  });

  it("passes the search and limit through to intake", async () => {
    await discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive", search: "data engineer", limit: 10 });

    expect(mockedRunIntake).toHaveBeenCalledWith(
      expect.anything(),
      { sourceCode: "remotive", search: "data engineer", limit: 10 },
      expect.anything(),
    );
  });

  it("refuses to guess which source to query once several are registered", async () => {
    // This previously asserted that a bare call defaulted to the single
    // registered source. That default only ever existed because exactly one
    // adapter was registered (Remotive); once Jooble and Adzuna were added the
    // tool takes its documented multi-source branch instead, which is the
    // behavior asserted here. Reporting one source's results as though they were
    // the requested ones would be worse than an error naming the options.
    await expect(discoverLiveJobs({} as SupabaseClient, {})).rejects.toThrow(/source_code is required/);

    // The message lists the registered sources, so the caller can pick one.
    await expect(discoverLiveJobs({} as SupabaseClient, {})).rejects.toThrow(/remotive/);
    expect(mockedRunIntake).not.toHaveBeenCalled();
  });

  it("returns the ingested vacancies so an agent can act on them", async () => {
    const result = await discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive" });

    expect(result.vacancies).toEqual([
      {
        vacancyId: "vac-1",
        title: "Senior Data Engineer",
        companyName: "Acme",
        outcome: "created",
        trustStatus: "VERIFIED_INCOMPLETE",
      },
    ]);
    expect(result.ingested).toBe(10);
    expect(result.received).toBe(12);
    expect(result.skippedByAdapter).toBe(2);
  });

  it("says up front that these vacancies cannot be queued, instead of letting the agent find out", async () => {
    const result = await discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive" });

    // Discovered from a source with no submission adapter: queue_applications
    // will reject every one of them with NO_ADAPTER_REGISTERED_FOR_SOURCE.
    expect(result.applicationSupported).toBe(false);
    expect(result.applicationSupportNote).toContain("NO_ADAPTER_REGISTERED_FOR_SOURCE");
  });

  it("carries the source's attribution, because the obligation travels with the data", async () => {
    const result = await discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive" });

    expect(result.attribution).toContain("Remotive");
  });

  it("reports the distribution of statuses the scorer decided", async () => {
    const result = await discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive" });

    expect(result.trustStatusCounts).toEqual({ VERIFIED_INCOMPLETE: 10 });
  });

  it("reports each vacancy's own status, so a FLAGGED listing is not hidden by an average", async () => {
    const result = await discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive" });

    expect(result.vacancies[0].trustStatus).toBe("VERIFIED_INCOMPLETE");
  });

  it("rejects a non-positive limit", async () => {
    await expect(discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive", limit: 0 })).rejects.toBeInstanceOf(IntakeInputError);
    expect(mockedRunIntake).not.toHaveBeenCalled();
  });

  it("propagates a policy refusal unchanged, so the agent sees why", async () => {
    mockedRunIntake.mockRejectedValueOnce(new Error('Intake is not permitted for source "remotive": its kill_switch is on'));

    await expect(discoverLiveJobs({} as SupabaseClient, { sourceCode: "remotive" })).rejects.toThrow(/kill_switch is on/);
  });
});
