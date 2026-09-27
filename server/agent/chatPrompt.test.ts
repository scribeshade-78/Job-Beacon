import { describe, expect, it } from "vitest";
import {
  AGENT_CHAT_PROMPT_VERSION,
  buildAgentMessages,
  EmptyAgentReplyError,
  readAgentReply,
  readDefaultAgentModel,
} from "./chatPrompt.js";
import { DEFAULT_AGENT_MODEL } from "../../shared/agent.js";

const EMPTY_CONTEXT = { targetRoles: [], confirmedFacts: [], applicationPlans: [], fitAnalyses: [] };

describe("readDefaultAgentModel", () => {
  it("falls back to the documented default when nothing is configured", () => {
    expect(readDefaultAgentModel({})).toBe(DEFAULT_AGENT_MODEL);
  });

  it("prefers AGENT_CHAT_MODEL over the generic model variables", () => {
    expect(
      readDefaultAgentModel({
        AGENT_CHAT_MODEL: "anthropic/claude-sonnet-4.5",
        OPENAI_MODEL: "openai/gpt-4o-mini",
      }),
    ).toBe("anthropic/claude-sonnet-4.5");
  });

  it("falls through to OPENAI_MODEL then OPENROUTER_MODEL", () => {
    expect(readDefaultAgentModel({ OPENAI_MODEL: "anthropic/claude-sonnet-4.5" })).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(readDefaultAgentModel({ OPENROUTER_MODEL: "anthropic/claude-sonnet-4.5" })).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  /**
   * The env chain must not become a way around the whitelist: an operator
   * pointing a generic variable at an unlisted model must not make that model
   * the default, because the picker could then never show what is in use.
   */
  it("ignores an unlisted model in every variable", () => {
    expect(
      readDefaultAgentModel({
        AGENT_CHAT_MODEL: "evil/unlisted",
        OPENAI_MODEL: "evil/unlisted",
        OPENROUTER_MODEL: "evil/unlisted",
      }),
    ).toBe(DEFAULT_AGENT_MODEL);
  });
});

describe("buildAgentMessages", () => {
  it("puts the system prompt and the delimited context first, then the transcript verbatim", () => {
    const messages = buildAgentMessages(EMPTY_CONTEXT, [
      { role: "user", content: "Which jobs fit me?" },
      { role: "assistant", content: "Here is what I can see." },
      { role: "user", content: "And the gaps?" },
    ]);

    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(String(messages[0].content)).toContain("JobBeacon Career Copilot");
    expect(String(messages[0].content)).toContain("--- BEGIN CANDIDATE CONTEXT (untrusted data) ---");
    expect(messages.slice(1)).toEqual([
      { role: "user", content: "Which jobs fit me?" },
      { role: "assistant", content: "Here is what I can see." },
      { role: "user", content: "And the gaps?" },
    ]);
  });

  it("states the grounding rule and the no-actions rule", () => {
    const messages = buildAgentMessages(EMPTY_CONTEXT, [{ role: "user", content: "hi" }]);
    const system = String(messages[0].content);

    expect(system).toContain("Never invent");
    expect(system).toContain("You cannot take actions");
  });

  it("carries a prompt version for later correlation", () => {
    expect(AGENT_CHAT_PROMPT_VERSION).toBe("agent-chat-v1");
  });
});

describe("readAgentReply", () => {
  it("trims the content", () => {
    expect(readAgentReply({ choices: [{ message: { content: "  hello  " } }] })).toBe("hello");
  });

  it("throws EmptyAgentReplyError for a missing, empty or whitespace reply", () => {
    expect(() => readAgentReply({ choices: [] })).toThrow(EmptyAgentReplyError);
    expect(() => readAgentReply({ choices: [{ message: { content: "" } }] })).toThrow(EmptyAgentReplyError);
    expect(() => readAgentReply({ choices: [{ message: { content: "   " } }] })).toThrow(EmptyAgentReplyError);
    expect(() => readAgentReply({})).toThrow(EmptyAgentReplyError);
  });
});
