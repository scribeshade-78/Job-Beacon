import { describe, expect, it, vi } from "vitest";
import { answerAgentChat, parseAgentChatRequest } from "./chat.js";
import {
  AGENT_MAX_HISTORY_TURNS,
  AGENT_MAX_MESSAGE_CHARS,
  AGENT_MAX_TOOL_PROPOSALS,
} from "../../shared/agent.js";

function makeClient(tables: Record<string, unknown> = {}) {
  return {
    from: (table: string) => {
      const result = { data: tables[table] ?? [], error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      for (const method of ["select", "eq", "in", "order", "limit"]) {
        builder[method] = chain;
      }

      builder.then = (resolve: (value: unknown) => unknown) => resolve(result);

      return builder;
    },
  } as never;
}

function makeOpenAI(content: string | null = "You have three plans.") {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } } as never, create };
}

const QUESTION = [{ role: "user" as const, content: "What are my plans?" }];

describe("parseAgentChatRequest", () => {
  it("accepts a minimal valid transcript and leaves the model unset", () => {
    const parsed = parseAgentChatRequest({ messages: QUESTION });

    expect(parsed).toEqual({ ok: true, messages: QUESTION, model: undefined });
  });

  it("accepts a whitelisted model", () => {
    const parsed = parseAgentChatRequest({ messages: QUESTION, model: "anthropic/claude-sonnet-4.5" });

    expect(parsed.ok && parsed.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("rejects a body that is not an object", () => {
    expect(parseAgentChatRequest(null).ok).toBe(false);
    expect(parseAgentChatRequest([]).ok).toBe(false);
    expect(parseAgentChatRequest("nope").ok).toBe(false);
  });

  it("rejects a missing or empty transcript", () => {
    expect(parseAgentChatRequest({}).ok).toBe(false);
    expect(parseAgentChatRequest({ messages: [] }).ok).toBe(false);
    expect(parseAgentChatRequest({ messages: "hello" }).ok).toBe(false);
  });

  it("rejects an over-long transcript", () => {
    const messages = Array.from({ length: AGENT_MAX_HISTORY_TURNS + 1 }, () => ({
      role: "user",
      content: "hi",
    }));

    const parsed = parseAgentChatRequest({ messages });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain(String(AGENT_MAX_HISTORY_TURNS));
  });

  it("rejects an unknown role, empty content and over-long content", () => {
    expect(parseAgentChatRequest({ messages: [{ role: "system", content: "hi" }] }).ok).toBe(false);
    expect(parseAgentChatRequest({ messages: [{ role: "user", content: "   " }] }).ok).toBe(false);
    expect(
      parseAgentChatRequest({ messages: [{ role: "user", content: "x".repeat(AGENT_MAX_MESSAGE_CHARS + 1) }] }).ok,
    ).toBe(false);
  });

  it("names the offending index so a 400 is actionable", () => {
    const parsed = parseAgentChatRequest({
      messages: [{ role: "user", content: "ok" }, { role: "user", content: "" }],
    });

    expect(parsed.ok === false && parsed.message).toContain("messages[1]");
  });

  it("rejects a transcript that ends on an assistant turn", () => {
    const parsed = parseAgentChatRequest({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });

    expect(parsed.ok).toBe(false);
  });

  /**
   * The model field is client-supplied, so this is the check that stops a
   * candidate spending against an arbitrary OpenRouter model.
   */
  it("rejects a model outside the whitelist", () => {
    const parsed = parseAgentChatRequest({ messages: QUESTION, model: "openai/gpt-4" });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toBe("model is not one of the available models.");
  });

  it("treats an explicit null model as absent rather than invalid", () => {
    const parsed = parseAgentChatRequest({ messages: QUESTION, model: null });

    expect(parsed).toEqual({ ok: true, messages: QUESTION, model: undefined });
  });
});

describe("answerAgentChat", () => {
  it("returns the reply and the model that produced it", async () => {
    const { client } = makeOpenAI("You have 2 plans.");

    const result = await answerAgentChat(makeClient(), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result).toEqual({
      kind: "success",
      message: "You have 2 plans.",
      model: "openai/gpt-4o-mini",
      proposals: [],
    });
  });

  it("sends the candidate context and the transcript to the model", async () => {
    const { client, create } = makeOpenAI();

    await answerAgentChat(
      makeClient({
        candidate_selected_roles: [{ role_name: "Platform Engineer" }],
      }),
      client,
      { candidateId: "user-123", messages: QUESTION },
    );

    const call = create.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };

    expect(call.messages[0].role).toBe("system");
    expect(call.messages[0].content).toContain("Platform Engineer");
    expect(call.messages[0].content).toContain("--- BEGIN CANDIDATE CONTEXT (untrusted data) ---");
    expect(call.messages[1]).toEqual({ role: "user", content: "What are my plans?" });
  });

  it("honours the requested model", async () => {
    const { client, create } = makeOpenAI();

    await answerAgentChat(makeClient(), client, {
      candidateId: "user-123",
      messages: QUESTION,
      model: "anthropic/claude-sonnet-4.5",
    });

    expect((create.mock.calls[0][0] as { model: string }).model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("sends only the tail of an over-long transcript", async () => {
    const { client, create } = makeOpenAI();
    const messages = Array.from({ length: AGENT_MAX_HISTORY_TURNS + 5 }, (_, index) => ({
      role: "user" as const,
      content: "message " + index,
    }));

    await answerAgentChat(makeClient(), client, { candidateId: "user-123", messages });

    const call = create.mock.calls[0][0] as { messages: Array<{ content: string }> };
    // One system message plus the capped tail.
    expect(call.messages).toHaveLength(AGENT_MAX_HISTORY_TURNS + 1);
    expect(call.messages[call.messages.length - 1].content).toBe("message " + (messages.length - 1));
  });

  it("reports an empty model reply as empty_reply, not as an error", async () => {
    const { client } = makeOpenAI("");

    const result = await answerAgentChat(makeClient(), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind).toBe("empty_reply");
  });

  it("reports a provider failure as error and keeps the reason", async () => {
    const create = vi.fn().mockRejectedValue(new Error("upstream is down"));
    const client = { chat: { completions: { create } } } as never;

    const result = await answerAgentChat(makeClient(), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result).toEqual({ kind: "error", message: "upstream is down" });
  });

  it("reports a context read failure as error rather than calling the model", async () => {
    const create = vi.fn();
    const client = {
      from: () => {
        throw new Error("PostgREST unreachable");
      },
    } as never;

    const result = await answerAgentChat(client, { chat: { completions: { create } } } as never, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result).toEqual({ kind: "error", message: "PostgREST unreachable" });
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// R4 — proposals from tool calls.
// ---------------------------------------------------------------------------

const VACANCY_ID = "11111111-1111-1111-1111-111111111111";

/** A model that answers by calling a tool, optionally with prose alongside. */
function makeToolCallingOpenAI(
  calls: Array<{ id?: string; function: { name: string; arguments: string } }>,
  content: string | null = null,
) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content, tool_calls: calls } }] });
  return { client: { chat: { completions: { create } } } as never, create };
}

function toolCall(name: string, args: unknown, id = "call_1") {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

const VACANCIES_TABLE = {
  vacancies: [{ id: VACANCY_ID, raw_title: "Platform Engineer", companies: { displayed_name: "Acme" } }],
};

describe("answerAgentChat with tool calls", () => {
  it("offers the implemented tools and lets the model choose", async () => {
    const { client, create } = makeOpenAI();

    await answerAgentChat(makeClient(), client, { candidateId: "user-123", messages: QUESTION });

    const call = create.mock.calls[0][0] as { tools?: unknown[]; tool_choice?: string };

    expect(Array.isArray(call.tools)).toBe(true);
    expect(call.tools).toHaveLength(1);
    expect(call.tool_choice).toBe("auto");
  });

  /**
   * THE CENTRAL PROPERTY. A tool call produces a CARD, not an effect: the result
   * carries a proposal and the queueing function is never invoked from here.
   */
  it("turns a tool call into an inert proposal built from the database", async () => {
    const { client } = makeToolCallingOpenAI([
      toolCall("queue_applications", { vacancyIds: [VACANCY_ID] }),
    ]);

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind).toBe("success");
    expect(result.kind === "success" && result.proposals).toEqual([
      {
        tool: "queue_applications",
        title: "Queue this application",
        lines: ["Platform Engineer at Acme"],
        confirmLabel: "Queue application",
        arguments: { vacancyIds: [VACANCY_ID] },
      },
    ]);
  });

  it("returns cards with empty prose for a purely tool-calling turn", async () => {
    const { client } = makeToolCallingOpenAI([
      toolCall("queue_applications", { vacancyIds: [VACANCY_ID] }),
    ]);

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    // Empty is correct here, not a failure: the drawer renders the card.
    expect(result.kind === "success" && result.message).toBe("");
  });

  it("keeps the model's prose alongside the card", async () => {
    const { client } = makeToolCallingOpenAI(
      [toolCall("queue_applications", { vacancyIds: [VACANCY_ID] })],
      "Here is what I would queue.",
    );

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind === "success" && result.message).toBe("Here is what I would queue.");
    expect(result.kind === "success" && result.proposals).toHaveLength(1);
  });

  /**
   * The hallucination guard, at the chat layer: a proposal naming a vacancy that
   * is not in JobBeacon must not become an Approve button.
   */
  it("drops a proposal naming a vacancy that does not exist", async () => {
    const { client } = makeToolCallingOpenAI([
      toolCall("queue_applications", { vacancyIds: ["99999999-9999-9999-9999-999999999999"] }),
    ]);

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind === "success" && result.proposals).toEqual([]);
    expect(result.kind === "success" && result.message).toContain("could not prepare that action");
  });

  it("drops a call to a tool that is not implemented", async () => {
    const { client } = makeToolCallingOpenAI([
      toolCall("send_follow_up_email", { draftId: "d1" }),
    ]);

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind === "success" && result.proposals).toEqual([]);
  });

  it("drops a call whose arguments are not JSON", async () => {
    const { client } = makeToolCallingOpenAI([
      { id: "call_1", function: { name: "queue_applications", arguments: "not json at all" } },
    ]);

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind === "success" && result.proposals).toEqual([]);
  });

  it("caps the cards returned in one reply", async () => {
    const calls = Array.from({ length: AGENT_MAX_TOOL_PROPOSALS + 3 }, (_, index) => ({
      id: "call_" + index,
      function: { name: "queue_applications", arguments: JSON.stringify({ vacancyIds: [VACANCY_ID] }) },
    }));
    const { client } = makeToolCallingOpenAI(calls);

    const result = await answerAgentChat(makeClient(VACANCIES_TABLE), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind === "success" && result.proposals).toHaveLength(AGENT_MAX_TOOL_PROPOSALS);
  });

  it("still reports an empty answer as empty_reply when there is no tool call", async () => {
    const { client } = makeOpenAI("");

    const result = await answerAgentChat(makeClient(), client, {
      candidateId: "user-123",
      messages: QUESTION,
    });

    expect(result.kind).toBe("empty_reply");
  });
});
