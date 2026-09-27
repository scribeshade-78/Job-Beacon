import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendAgentTurn,
  deriveConversationTitle,
  getActiveConversation,
  getAgentSnapshot,
  requestAgentAction,
  requestAgentChat,
  resetAgentStore,
  selectConversation,
  setProposalState,
  startNewConversation,
  subscribeAgentStore,
  toRequestMessages,
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
    ).resolves.toEqual({ kind: "success", message: "  Two plans.  ", model: "m-1", proposals: [] });
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

// ---------------------------------------------------------------------------
// R4 — proposals and the one call that acts.
// ---------------------------------------------------------------------------

const PROPOSAL = {
  tool: "queue_applications" as const,
  title: "Queue this application",
  lines: ["Platform Engineer at Acme"],
  confirmLabel: "Queue application",
  arguments: { vacancyIds: ["11111111-1111-1111-1111-111111111111"] },
};

describe("requestAgentChat with proposals", () => {
  it("parses the proposals the server returned", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "", model: "m", proposals: [PROPOSAL] }));

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ kind: "success", message: "", model: "m", proposals: [PROPOSAL] });
  });

  it("treats an empty prose reply as a success when it carries a card", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "", model: "m", proposals: [PROPOSAL] }));

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    // A purely tool-calling turn is normal, not a 502.
    expect(result.kind).toBe("success");
  });

  it("still treats an empty reply with no card as a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "  ", model: "m", proposals: [] }));

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind).toBe("error");
  });

  it("ignores a malformed proposal rather than rendering a broken card", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { message: "ok", model: "m", proposals: [{ tool: "queue_applications" }, null, 7] }),
    );

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind === "success" && result.proposals).toEqual([]);
  });

  it("defaults to no proposals when the field is absent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "ok", model: "m" }));

    const result = await requestAgentChat(QUESTION, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result.kind === "success" && result.proposals).toEqual([]);
  });
});

describe("requestAgentAction", () => {
  it("POSTs the tool and its arguments to the execute route", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "executed", tool: "queue_applications", summary: "Queued 1 of 1.", detail: {} }));

    await requestAgentAction("queue_applications", PROPOSAL.arguments, "tok-1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/agent/actions/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-1" },
      body: JSON.stringify({ tool: "queue_applications", arguments: PROPOSAL.arguments }),
    });
  });

  it("returns the server's summary and detail", async () => {
    const detail = { queued: 1 };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "executed", tool: "queue_applications", summary: "Queued 1 of 1.", detail }));

    await expect(
      requestAgentAction("queue_applications", PROPOSAL.arguments, "tok", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "executed", tool: "queue_applications", summary: "Queued 1 of 1.", detail });
  });

  it("maps a 4xx to unavailable, carrying the server's explanation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "tool is not one of the available actions." }));

    await expect(
      requestAgentAction("send_follow_up_email", {}, "tok", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "unavailable", message: "tool is not one of the available actions." });
  });

  it("maps a 5xx to a retryable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await expect(
      requestAgentAction("queue_applications", PROPOSAL.arguments, "tok", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "error", message: "boom" });
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      requestAgentAction("queue_applications", PROPOSAL.arguments, "tok", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "error", message: "Network error contacting the server." });
  });

  it("treats a 200 with no summary as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { status: "executed" }));

    const result = await requestAgentAction("queue_applications", PROPOSAL.arguments, "tok", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.kind).toBe("error");
  });
});

describe("transcript entries with proposals", () => {
  it("starts a proposal pending and moves it when decided", () => {
    startNewConversation(1000);
    const entryId = appendAgentTurn("assistant", "Shall I queue it?", [PROPOSAL]);

    expect(getActiveConversation()?.messages[0].proposals[0]).toEqual({
      proposal: PROPOSAL,
      state: "pending",
      message: "",
    });

    setProposalState(entryId, 0, "done", "Queued 1 of 1.");

    expect(getActiveConversation()?.messages[0].proposals[0]).toEqual({
      proposal: PROPOSAL,
      state: "done",
      message: "Queued 1 of 1.",
    });
  });

  it("leaves other entries and proposals untouched", () => {
    startNewConversation(1000);
    const first = appendAgentTurn("assistant", "a", [PROPOSAL, PROPOSAL]);
    appendAgentTurn("assistant", "b", [PROPOSAL]);

    setProposalState(first, 1, "dismissed");

    const messages = getActiveConversation()?.messages ?? [];

    expect(messages[0].proposals[0].state).toBe("pending");
    expect(messages[0].proposals[1].state).toBe("dismissed");
    expect(messages[1].proposals[0].state).toBe("pending");
  });

  it("ignores an update for an unknown entry id", () => {
    startNewConversation(1000);
    appendAgentTurn("assistant", "a", [PROPOSAL]);

    setProposalState("nope", 0, "done", "x");

    expect(getActiveConversation()?.messages[0].proposals[0].state).toBe("pending");
  });

  /**
   * A purely tool-calling assistant turn has empty prose, and the server rejects
   * an empty message outright — so sending it back would turn the next question
   * into a 400.
   */
  it("omits prose-free turns from what is sent back to the server", () => {
    startNewConversation(1000);
    appendAgentTurn("user", "queue it for me");
    appendAgentTurn("assistant", "", [PROPOSAL]);
    appendAgentTurn("user", "thanks");

    expect(toRequestMessages(getActiveConversation())).toEqual([
      { role: "user", content: "queue it for me" },
      { role: "user", content: "thanks" },
    ]);
  });

  it("returns nothing to send when there is no conversation", () => {
    expect(toRequestMessages(null)).toEqual([]);
  });
});
