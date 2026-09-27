import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendAgentTurn,
  deriveConversationTitle,
  getActiveConversation,
  getAgentSnapshot,
  requestAgentChat,
  resetAgentStore,
  selectConversation,
  startNewConversation,
  subscribeAgentStore,
} from "./agentChat";
import { AGENT_MAX_HISTORY_TURNS, type AgentChatMessage } from "../../../shared/agent";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A response whose body is not JSON at all. */
function unparseableResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

const QUESTION: AgentChatMessage[] = [{ role: "user", content: "What are my plans?" }];

afterEach(() => {
  resetAgentStore();
});

describe("requestAgentChat", () => {
  it("POSTs the transcript to /api/agent/chat with the bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "Two plans.", model: "openai/gpt-4o-mini" }));

    await requestAgentChat(QUESTION, "tok-123", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledWith("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-123" },
      body: JSON.stringify({ messages: QUESTION }),
    });
  });

  it("includes the model only when one was chosen", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "ok", model: "m" }));

    await requestAgentChat(QUESTION, "tok", {
      model: "anthropic/claude-sonnet-4.5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);

    expect(body.model).toBe("anthropic/claude-sonnet-4.5");
  });

  it("sends only the tail of an over-long transcript", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "ok", model: "m" }));
    const messages: AgentChatMessage[] = Array.from({ length: AGENT_MAX_HISTORY_TURNS + 5 }, (_, index) => ({
      role: "user",
      content: "message " + index,
    }));

    await requestAgentChat(messages, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);

    expect(body.messages).toHaveLength(AGENT_MAX_HISTORY_TURNS);
    expect(body.messages[body.messages.length - 1].content).toBe("message " + (messages.length - 1));
  });

  it("returns the answer and model on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "  Two plans.  ", model: "m-1" }));

    await expect(
      requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "success", message: "  Two plans.  ", model: "m-1" });
  });

  it("maps a 4xx to unavailable, carrying the server's explanation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: "model is not one of the available models." }));

    await expect(
      requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", message: "model is not one of the available models." });
  });

  it("maps a 5xx to a retryable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await expect(
      requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "error", message: "boom" });
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "error", message: "Network error contacting the server." });
  });

  it("falls back to a generic message when an error body is not JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(unparseableResponse(500));

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("error");
  });

  it("treats an ok response with no message as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "   " }));

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("error");
  });
});

describe("deriveConversationTitle", () => {
  it("collapses whitespace", () => {
    expect(deriveConversationTitle("  Show   my   plans ")).toBe("Show my plans");
  });

  it("truncates a long question with an ellipsis", () => {
    const title = deriveConversationTitle("x".repeat(100));

    expect(title).toHaveLength(48);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("the session transcript store", () => {
  it("starts empty and activates a new conversation", () => {
    expect(getAgentSnapshot()).toEqual({ conversations: [], activeId: null });

    const id = startNewConversation(1000);

    expect(getAgentSnapshot().activeId).toBe(id);
    expect(getActiveConversation()?.messages).toEqual([]);
    expect(getActiveConversation()?.title).toBe("New chat");
  });

  it("titles a conversation from its first user message", () => {
    startNewConversation(1000);
    appendAgentTurn("user", "Show my top-matching jobs today");
    appendAgentTurn("assistant", "Here you go.");
    appendAgentTurn("user", "and the gaps?");

    expect(getActiveConversation()?.title).toBe("Show my top-matching jobs today");
    expect(getActiveConversation()?.messages).toHaveLength(3);
  });

  it("leaves the title alone when the first turn is the assistant's", () => {
    startNewConversation(1000);
    appendAgentTurn("assistant", "Hello");

    expect(getActiveConversation()?.title).toBe("New chat");
  });

  it("ignores a turn when no conversation is active", () => {
    appendAgentTurn("user", "orphan");

    expect(getAgentSnapshot().conversations).toEqual([]);
  });

  it("switches between conversations and ignores an unknown id", () => {
    const first = startNewConversation(1000);
    const second = startNewConversation(2000);

    expect(getAgentSnapshot().activeId).toBe(second);

    selectConversation(first);
    expect(getAgentSnapshot().activeId).toBe(first);

    selectConversation("does-not-exist");
    expect(getAgentSnapshot().activeId).toBe(first);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAgentStore(listener);

    startNewConversation(1000);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    startNewConversation(2000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /**
   * useSyncExternalStore compares snapshots by identity, so a mutation that
   * reused the previous object would silently stop re-rendering the drawer.
   */
  it("hands out a new snapshot object on every change", () => {
    startNewConversation(1000);
    const before = getAgentSnapshot();

    appendAgentTurn("user", "hi");

    expect(getAgentSnapshot()).not.toBe(before);
  });

  it("resets for the next case", () => {
    startNewConversation(1000);
    resetAgentStore();

    expect(getAgentSnapshot()).toEqual({ conversations: [], activeId: null });
  });
});
