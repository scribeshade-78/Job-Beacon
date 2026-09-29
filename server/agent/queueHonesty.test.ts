import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Copilot queue honesty fix — behavioral tests.
 *
 * THE BUG THESE PIN. queue_applications was advertised unconditionally, so the
 * model offered an action that no source could carry out; approving it marked
 * the card done while queueing nothing. Every assertion here is about what the
 * candidate is shown or offered, not about the eligibility engine, which has its
 * own suite.
 *
 * bulkApplyToVacancies is mocked for the same reason actions.test.ts mocks it:
 * these are boundary tests. loadQueueCapability is mocked so the two branches
 * (a source can queue / none can) are exercised directly rather than inferred
 * from fixture rows.
 */
vi.mock("../applications/bulkApply.js", () => ({
  MAX_BULK_APPLY_VACANCIES: 100,
  bulkApplyToVacancies: vi.fn(),
}));

vi.mock("../applications/queueCapability.js", () => ({
  loadQueueCapability: vi.fn(),
}));

vi.mock("../audit/log.js", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue({ recorded: true }),
}));

import { bulkApplyToVacancies } from "../applications/bulkApply.js";
import { loadQueueCapability } from "../applications/queueCapability.js";
import { recordAuditEvent } from "../audit/log.js";
import { executeAgentAction } from "./actions.js";
import { agentToolDescriptors, buildAgentProposal, summarizeBulkApply } from "./tools.js";

const bulkApplyMock = vi.mocked(bulkApplyToVacancies);
const capabilityMock = vi.mocked(loadQueueCapability);
const auditMock = vi.mocked(recordAuditEvent);

const VACANCY_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_VACANCY_ID = "22222222-2222-2222-2222-222222222222";
const CANDIDATE_ID = "user-123";

const CAN_QUEUE = { canQueue: true, queueableSources: ["greenhouse"] };
const CANNOT_QUEUE = { canQueue: false, queueableSources: [] };

function makeClient(vacancies: unknown[] = [
  { id: VACANCY_ID, raw_title: "Platform Engineer", companies: { displayed_name: "Acme" } },
]) {
  return {
    from: () => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["select", "eq", "in", "order", "limit"]) {
        builder[method] = chain;
      }

      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: vacancies, error: null });

      return builder;
    },
  } as never;
}

function blockedOutcome(vacancyId: string, reasonCode: string) {
  return {
    vacancyId,
    status: "blocked" as const,
    blockingGates: [{ gate: "application_support", reasonCode }],
  };
}

afterEach(() => {
  vi.clearAllMocks();
  capabilityMock.mockResolvedValue(CAN_QUEUE);
});

describe("tool advertisement when no source can queue", () => {
  it("advertises queue_applications when a source with vacancies can queue", () => {
    expect(agentToolDescriptors(CAN_QUEUE).map((entry) => entry.function.name)).toEqual([
      "queue_applications",
    ]);
  });

  /**
   * An empty array is the point: with nothing offered, the model has no
   * queue tool to call, so no Approve card can be produced at all.
   */
  it("advertises nothing when no source can queue", () => {
    expect(agentToolDescriptors(CANNOT_QUEUE)).toEqual([]);
  });

  it("still advertises everything when no capability is supplied", () => {
    // Backwards-compatible default: the descriptor tests in actions.test.ts
    // assert the full registry and must keep passing.
    expect(agentToolDescriptors().map((entry) => entry.function.name)).toEqual(["queue_applications"]);
  });
});

describe("stale proposal refusal", () => {
  it("refuses to build a proposal when no source can queue", async () => {
    const result = await buildAgentProposal(
      makeClient(),
      "queue_applications",
      { vacancyIds: [VACANCY_ID] },
      CANDIDATE_ID,
      CANNOT_QUEUE,
    );

    expect(result.ok).toBe(false);
  });

  it("still builds the proposal when a source can queue", async () => {
    const result = await buildAgentProposal(
      makeClient(),
      "queue_applications",
      { vacancyIds: [VACANCY_ID] },
      CANDIDATE_ID,
      CAN_QUEUE,
    );

    expect(result.ok).toBe(true);
  });

  /**
   * A STALE CARD IS CAUGHT BY THE GATES, NOT BY RE-READING THE CAPABILITY.
   * The transcript lives in the browser, so an approval can arrive after the
   * policy that allowed it disappeared. The engine evaluates the gates per
   * vacancy at execution time regardless, so the run still happens, every job
   * is refused, and the candidate gets a blocked explanation with the real
   * reasons — which is both honest and cheaper than a second capability read.
   */
  it("reports a stale approval as blocked, using the gates' own reasons", async () => {
    capabilityMock.mockResolvedValue(CANNOT_QUEUE);
    bulkApplyMock.mockResolvedValue({
      requested: 1,
      queued: 0,
      blocked: 1,
      errors: 0,
      outcomes: [blockedOutcome(VACANCY_ID, "SOURCE_APPLICATION_NOT_AUTHORIZED")],
    });

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(result.kind).toBe("blocked");
    // It must reach the engine: the gates, not a cached capability, decide.
    expect(bulkApplyMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The infrastructure path must stay loud. A database that is down is a 500 —
   * never "no source supports this", which would disguise an outage as a
   * product limitation.
   */
  it("still reports an infrastructure failure as failed, not blocked", async () => {
    bulkApplyMock.mockRejectedValue(new Error("PostgREST unreachable"));

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(result).toEqual({ kind: "failed", message: "PostgREST unreachable" });
  });
});

describe("all jobs blocked", () => {
  it("is not reported as a completed action", async () => {
    capabilityMock.mockResolvedValue(CAN_QUEUE);
    bulkApplyMock.mockResolvedValue({
      requested: 2,
      queued: 0,
      blocked: 2,
      errors: 0,
      outcomes: [
        blockedOutcome(VACANCY_ID, "NO_ADAPTER_REGISTERED_FOR_SOURCE"),
        blockedOutcome(OTHER_VACANCY_ID, "NO_ADAPTER_REGISTERED_FOR_SOURCE"),
      ],
    });

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID, OTHER_VACANCY_ID] },
    });

    expect(result.kind).toBe("blocked");
  });

  it("explains the reason in plain language rather than a gate code", () => {
    const summary = summarizeBulkApply({
      requested: 1,
      queued: 0,
      blocked: 1,
      errors: 0,
      outcomes: [blockedOutcome(VACANCY_ID, "NO_ADAPTER_REGISTERED_FOR_SOURCE")],
    });

    expect(summary).toContain("No applications queued");
    expect(summary).toContain("aren't available for these jobs yet");
    // The raw identifier must not be the primary copy.
    expect(summary).not.toContain("NO_ADAPTER_REGISTERED_FOR_SOURCE");
  });

  it("records a blocked run as blocked, not as executed or failed", async () => {
    capabilityMock.mockResolvedValue(CAN_QUEUE);
    bulkApplyMock.mockResolvedValue({
      requested: 1,
      queued: 0,
      blocked: 1,
      errors: 0,
      outcomes: [blockedOutcome(VACANCY_ID, "SOURCE_APPLICATION_NOT_AUTHORIZED")],
    });

    await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].action).toBe("agent.action.blocked");
  });
});

describe("partial success", () => {
  it("stays a completed action and keeps both counts", async () => {
    capabilityMock.mockResolvedValue(CAN_QUEUE);
    bulkApplyMock.mockResolvedValue({
      requested: 2,
      queued: 1,
      blocked: 1,
      errors: 0,
      outcomes: [
        { vacancyId: VACANCY_ID, status: "queued", blockingGates: [] },
        blockedOutcome(OTHER_VACANCY_ID, "VACANCY_TRUST_STATUS_INELIGIBLE"),
      ],
    });

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID, OTHER_VACANCY_ID] },
    });

    // One real queue is still real work: reporting it as blocked would lose it.
    expect(result.kind).toBe("executed");
    expect(result.kind === "executed" && result.summary).toBe(
      "Queued 1 of 2. 1 blocked by eligibility gates.",
    );
  });
});

describe("genuine success", () => {
  it("reports the queued count and audits an executed run", async () => {
    capabilityMock.mockResolvedValue(CAN_QUEUE);
    bulkApplyMock.mockResolvedValue({
      requested: 1,
      queued: 1,
      blocked: 0,
      errors: 0,
      outcomes: [{ vacancyId: VACANCY_ID, status: "queued", blockingGates: [] }],
    });

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(result.kind).toBe("executed");
    expect(result.kind === "executed" && result.summary).toBe("Queued 1 of 1.");
    expect(auditMock.mock.calls[0][1].action).toBe("agent.action.executed");
  });
});
