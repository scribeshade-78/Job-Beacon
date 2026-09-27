import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOL_NAMES,
  AGENT_MAX_ACTION_VACANCIES,
  type AgentToolName,
} from "../../shared/agent.js";

/**
 * bulkApplyToVacancies is the thing being WRAPPED, so it is mocked: these tests
 * are about the tool boundary — argument validation, refusal, the audit entry
 * and the summary — not about the eligibility engine, which has its own suite.
 * The one behavioural claim worth pinning is that the tool delegates to it at
 * all, because "the Copilot goes through the same gates" is the whole safety
 * argument and a future refactor could quietly stop doing that.
 */
vi.mock("../applications/bulkApply.js", () => ({
  MAX_BULK_APPLY_VACANCIES: 100,
  bulkApplyToVacancies: vi.fn(),
}));

vi.mock("../audit/log.js", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue({ recorded: true }),
}));

import { bulkApplyToVacancies } from "../applications/bulkApply.js";
import { recordAuditEvent } from "../audit/log.js";
import { executeAgentAction, parseAgentActionRequest } from "./actions.js";
import {
  AGENT_DENIED_ACTIONS,
  AGENT_TOOLS,
  agentToolDescriptors,
  buildAgentProposal,
} from "./tools.js";

const bulkApplyMock = vi.mocked(bulkApplyToVacancies);
const auditMock = vi.mocked(recordAuditEvent);

const VACANCY_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_VACANCY_ID = "22222222-2222-2222-2222-222222222222";
const CANDIDATE_ID = "user-123";

const APPLY_RESULT = {
  requested: 1,
  queued: 1,
  blocked: 0,
  errors: 0,
  outcomes: [{ vacancyId: VACANCY_ID, status: "queued" as const, blockingGates: [] }],
};

function makeClient(vacancies: unknown[] = [{ id: VACANCY_ID, raw_title: "Platform Engineer", companies: { displayed_name: "Acme" } }]) {
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

afterEach(() => {
  vi.clearAllMocks();
  bulkApplyMock.mockResolvedValue(APPLY_RESULT);
});

describe("the tool registry", () => {
  it("has a definition for every whitelisted tool name, and no extras", () => {
    expect([...AGENT_TOOLS.keys()].sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });

  /**
   * The whitelist is what the execute route trusts; the denylist is what a
   * reviewer reads. If a denied action ever acquired a tool name, this fails.
   */
  it("never implements a denied action", () => {
    for (const denied of AGENT_DENIED_ACTIONS) {
      expect(AGENT_TOOL_NAMES as readonly string[]).not.toContain(denied);
    }
  });

  it("advertises exactly the implemented tools to the model", () => {
    const descriptors = agentToolDescriptors();

    expect(descriptors.map((entry) => entry.function.name)).toEqual([...AGENT_TOOLS.keys()]);
    expect(descriptors.every((entry) => entry.type === "function")).toBe(true);
  });

  it("describes queue_applications as needing approval and states the cap", () => {
    const descriptor = agentToolDescriptors()[0];
    const parameters = descriptor.function.parameters as {
      properties: { vacancyIds: { maxItems: number } };
      required: string[];
    };

    expect(descriptor.function.description).toContain("approve");
    expect(parameters.required).toEqual(["vacancyIds"]);
    expect(parameters.properties.vacancyIds.maxItems).toBe(AGENT_MAX_ACTION_VACANCIES);
  });
});

describe("parseAgentActionRequest", () => {
  it("rejects a body that is not an object", () => {
    expect(parseAgentActionRequest(null).ok).toBe(false);
    expect(parseAgentActionRequest([]).ok).toBe(false);
    expect(parseAgentActionRequest("queue_applications").ok).toBe(false);
  });

  it("rejects an unknown or denied tool", () => {
    expect(parseAgentActionRequest({ tool: "send_follow_up_email" }).ok).toBe(false);
    expect(parseAgentActionRequest({ tool: "submit_application" }).ok).toBe(false);
    expect(parseAgentActionRequest({ tool: "" }).ok).toBe(false);
    expect(parseAgentActionRequest({}).ok).toBe(false);
  });

  it("accepts a whitelisted tool and defaults missing arguments to an empty object", () => {
    expect(parseAgentActionRequest({ tool: "queue_applications" })).toEqual({
      ok: true,
      tool: "queue_applications",
      args: {},
    });
  });

  it("passes the arguments through untouched for the tool's own parser", () => {
    const args = { vacancyIds: [VACANCY_ID] };

    expect(parseAgentActionRequest({ tool: "queue_applications", arguments: args })).toEqual({
      ok: true,
      tool: "queue_applications",
      args,
    });
  });
});

describe("executeAgentAction", () => {
  it("runs the tool and reports a summary", async () => {
    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(result).toEqual({
      kind: "executed",
      tool: "queue_applications",
      summary: "Queued 1 of 1.",
      detail: APPLY_RESULT,
    });
  });

  /**
   * THE SAFETY ARGUMENT IN ONE ASSERTION: the tool delegates to the same
   * function the Opportunities page's Apply button calls, so the Copilot
   * inherits every eligibility, consent and rate gate rather than inserting
   * rows of its own.
   */
  it("delegates to bulkApplyToVacancies with the verified candidate id", async () => {
    await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(bulkApplyMock).toHaveBeenCalledWith(expect.anything(), {
      candidateId: CANDIDATE_ID,
      vacancyIds: [VACANCY_ID],
    });
  });

  it("refuses a tool that is not in the registry", async () => {
    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "send_follow_up_email" as AgentToolName,
      args: {},
    });

    expect(result).toEqual({
      kind: "unknown_tool",
      message: "tool is not one of the available actions.",
    });
    expect(bulkApplyMock).not.toHaveBeenCalled();
  });

  it("refuses malformed arguments without running anything", async () => {
    const cases: unknown[] = [
      {},
      { vacancyIds: [] },
      { vacancyIds: "not-an-array" },
      { vacancyIds: ["not-a-uuid"] },
      { vacancyIds: Array.from({ length: AGENT_MAX_ACTION_VACANCIES + 1 }, () => VACANCY_ID) },
    ];

    for (const args of cases) {
      const result = await executeAgentAction(makeClient(), {
        candidateId: CANDIDATE_ID,
        tool: "queue_applications",
        args,
      });

      expect(result.kind).toBe("invalid_request");
    }

    expect(bulkApplyMock).not.toHaveBeenCalled();
  });

  it("deduplicates repeated ids so the summary cannot overstate what ran", async () => {
    await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID, VACANCY_ID, OTHER_VACANCY_ID] },
    });

    expect(bulkApplyMock).toHaveBeenCalledWith(expect.anything(), {
      candidateId: CANDIDATE_ID,
      vacancyIds: [VACANCY_ID, OTHER_VACANCY_ID],
    });
  });

  it("reports gate refusals as an executed run that queued less", async () => {
    bulkApplyMock.mockResolvedValue({
      requested: 2,
      queued: 1,
      blocked: 1,
      errors: 0,
      outcomes: [
        { vacancyId: VACANCY_ID, status: "queued", blockingGates: [] },
        {
          vacancyId: OTHER_VACANCY_ID,
          status: "blocked",
          blockingGates: [{ gate: "application_support", reasonCode: "NO_ADAPTER" }],
        },
      ],
    });

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID, OTHER_VACANCY_ID] },
    });

    // A blocked gate is a successful run, not a failure — the system worked and
    // the candidate is told why nothing was queued.
    expect(result.kind).toBe("executed");
    expect(result.kind === "executed" && result.summary).toBe(
      "Queued 1 of 2. 1 blocked by eligibility gates.",
    );
  });

  it("reports an infrastructure failure as failed", async () => {
    bulkApplyMock.mockRejectedValue(new Error("PostgREST unreachable"));

    const result = await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(result).toEqual({ kind: "failed", message: "PostgREST unreachable" });
  });

  it("audits a successful execution with the requested arguments and the outcome", async () => {
    await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    expect(auditMock).toHaveBeenCalledTimes(1);

    const [, input] = auditMock.mock.calls[0];

    expect(input.actorId).toBe(CANDIDATE_ID);
    expect(input.actorRole).toBe("candidate");
    expect(input.action).toBe("agent.action.executed");
    expect(input.entityType).toBe("agent_action");
    expect(input.summary).toContain("queue_applications");
    expect(input.newValues).toEqual({
      arguments: { vacancyIds: [VACANCY_ID] },
      result: APPLY_RESULT,
    });
  });

  /**
   * A failed attempt to act is exactly what an audit trail exists to record, so
   * the failure path is audited too rather than only the happy one.
   */
  it("audits a failure with its reason", async () => {
    bulkApplyMock.mockRejectedValue(new Error("boom"));

    await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: [VACANCY_ID] },
    });

    const [, input] = auditMock.mock.calls[0];

    expect(input.action).toBe("agent.action.failed");
    expect(input.reason).toBe("boom");
  });

  it("does not audit a request that was refused before it ran", async () => {
    await executeAgentAction(makeClient(), {
      candidateId: CANDIDATE_ID,
      tool: "queue_applications",
      args: { vacancyIds: ["not-a-uuid"] },
    });

    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("buildAgentProposal", () => {
  it("builds the card from the database, not from the model's arguments", async () => {
    const built = await buildAgentProposal(
      makeClient(),
      "queue_applications",
      { vacancyIds: [VACANCY_ID] },
      CANDIDATE_ID,
    );

    expect(built.ok).toBe(true);
    expect(built.ok && built.proposal).toEqual({
      tool: "queue_applications",
      title: "Queue this application",
      lines: ["Platform Engineer at Acme"],
      confirmLabel: "Queue application",
      arguments: { vacancyIds: [VACANCY_ID] },
    });
  });

  it("labels several vacancies with a count", async () => {
    const built = await buildAgentProposal(
      makeClient([
        { id: VACANCY_ID, raw_title: "Platform Engineer", companies: { displayed_name: "Acme" } },
        { id: OTHER_VACANCY_ID, raw_title: "Backend Engineer", companies: { displayed_name: "Globex" } },
      ]),
      "queue_applications",
      { vacancyIds: [VACANCY_ID, OTHER_VACANCY_ID] },
      CANDIDATE_ID,
    );

    expect(built.ok && built.proposal.title).toBe("Queue 2 applications");
    expect(built.ok && built.proposal.lines).toEqual([
      "Platform Engineer at Acme",
      "Backend Engineer at Globex",
    ]);
  });

  /**
   * THE HALLUCINATION GUARD. A model that invents a vacancy id must not get an
   * Approve button rendered for it, or the only thing between the invention and
   * a click would be the candidate's reading of the card.
   */
  it("refuses the whole proposal when a named vacancy does not exist", async () => {
    const built = await buildAgentProposal(
      makeClient([{ id: VACANCY_ID, raw_title: "Platform Engineer", companies: { displayed_name: "Acme" } }]),
      "queue_applications",
      { vacancyIds: [VACANCY_ID, OTHER_VACANCY_ID] },
      CANDIDATE_ID,
    );

    expect(built).toEqual({ ok: false, reason: "proposal named a vacancy that does not exist" });
  });

  it("refuses an unknown tool", async () => {
    const built = await buildAgentProposal(makeClient(), "send_follow_up_email", {}, CANDIDATE_ID);

    expect(built.ok).toBe(false);
  });

  it("refuses malformed arguments", async () => {
    const built = await buildAgentProposal(makeClient(), "queue_applications", { vacancyIds: [] }, CANDIDATE_ID);

    expect(built).toEqual({ ok: false, reason: "vacancyIds must be a non-empty array." });
  });
});
