import { describe, expect, it, vi } from "vitest";
import { answerAgentChat, parseAgentChatRequest } from "./chat.js";
import { AGENT_MAX_HISTORY_TURNS, AGENT_MAX_MESSAGE_CHARS } from "../../shared/agent.js";

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

    expect(result).toEqual({ kind: "success", message: "You have 2 plans.", model: "openai/gpt-4o-mini" });
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
