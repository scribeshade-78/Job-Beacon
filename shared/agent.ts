/**
 * AI Career Copilot — the contract shared by the drawer and the server.
 *
 * THE WHITELIST IS THE POINT OF THIS FILE. The model selector is a client-side
 * control, so whatever it offers is a value a client can send; without a
 * server-enforced list, any signed-in candidate could name an arbitrary
 * OpenRouter model and spend it against this deployment's key. The server
 * therefore treats a requested model as a HINT TO BE CHECKED against
 * AGENT_MODEL_IDS and never as a value to pass through, and the client imports
 * this same constant so the picker cannot offer something the server refuses.
 *
 * CLAUDE 3.5 SONNET IS DELIBERATELY ABSENT. It was named in the feature
 * specification, but OpenRouter no longer serves it — verified against
 * GET https://openrouter.ai/api/v1/models, where no claude-3.5-sonnet id
 * exists. Listing it would put an option in the picker that fails on every
 * send, so the nearest current Sonnet is offered instead.
 */

export const AGENT_MODEL_IDS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-sonnet-4.5",
] as const;

export type AgentModelId = (typeof AGENT_MODEL_IDS)[number];

/**
 * The cheaper model is the default. A picker that defaulted to the expensive
 * one would spend the larger amount on every candidate's first message before
 * they had expressed any preference.
 */
export const DEFAULT_AGENT_MODEL: AgentModelId = "openai/gpt-4o-mini";

export interface AgentModelOption {
  id: AgentModelId;
  label: string;
}

export const AGENT_MODEL_OPTIONS: readonly AgentModelOption[] = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
];

export function isAgentModelId(value: unknown): value is AgentModelId {
  return typeof value === "string" && (AGENT_MODEL_IDS as readonly string[]).includes(value);
}

/** The three quick actions, verbatim from the specification. */
export const AGENT_QUICK_PROMPTS = [
  "Show my top-matching jobs today",
  "Analyze my resume gaps for a target role",
  "Draft a follow-up for my pending applications",
] as const;

export type AgentChatRole = "user" | "assistant";

export interface AgentChatMessage {
  role: AgentChatRole;
  content: string;
}

/**
 * Bounds, and each is a cost control as much as a validation rule: the whole
 * transcript is re-sent on every turn, so an unbounded history is a request
 * whose price grows with its own length. The turn cap is applied to the TAIL
 * of the transcript, because the most recent turns are the ones a follow-up
 * question actually depends on.
 */
export const AGENT_MAX_HISTORY_TURNS = 20;
export const AGENT_MAX_MESSAGE_CHARS = 4000;

/** Per candidate, matching the interview-prep rate limit's shape. */
export const AGENT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const AGENT_RATE_LIMIT_MAX = 10;
