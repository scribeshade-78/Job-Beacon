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

// ---------------------------------------------------------------------------
// R4 — action execution.
// ---------------------------------------------------------------------------

/**
 * THE EXECUTABLE-TOOL WHITELIST, AND THE ONLY THING THE MODEL MAY PROPOSE.
 *
 * Same reasoning as AGENT_MODEL_IDS: a tool name arrives from the client (the
 * model's proposal is echoed back for approval), so it is checked against this
 * list and never dispatched by name. A name absent here cannot execute, whatever
 * the request says.
 *
 * ONLY IMPLEMENTED TOOLS ARE ADVERTISED to the model — a proposal the server
 * cannot carry out would render an Approve button that always fails. Adding a
 * name here without a matching entry in server/agent/tools.ts is a test failure,
 * not a silent 500.
 */
export const AGENT_TOOL_NAMES = ["queue_applications"] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === "string" && (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * An action the model has PROPOSED and a candidate may APPROVE.
 *
 * Nothing here has happened. Every field except `arguments` is built by the
 * SERVER from the candidate's own rows — the title, the lines and the button
 * label are deliberately NOT the model's words, so a model that invents a
 * company name cannot make the card it appears on show one.
 *
 * `arguments` IS UNTRUSTED ON THE WAY BACK. The client echoes it, so it is
 * re-validated from scratch at execution time and never dispatched as received.
 */
export interface AgentActionProposal {
  tool: AgentToolName;
  /** Server-built. Rendered as the card's heading. */
  title: string;
  /** Server-built. One entry per line of the card body. */
  lines: string[];
  /** Server-built. The button's own label, so "Queue 2 applications" is specific. */
  confirmLabel: string;
  /** Echoed back on approval; re-validated server-side. */
  arguments: Record<string, unknown>;
}

/**
 * Cards per reply are capped: a model that emits ten tool calls should not
 * produce a wall of Approve buttons the candidate has to read to be safe.
 */
export const AGENT_MAX_TOOL_PROPOSALS = 3;

/**
 * Vacancies one proposed action may cover. Far below
 * MAX_BULK_APPLY_VACANCIES (100) on purpose: that bound protects the endpoint
 * from a huge fan-out, whereas this one keeps an approval card to a list a
 * human can actually read before pressing the button.
 */
export const AGENT_MAX_ACTION_VACANCIES = 5;

/** Tighter than the chat limit: an execution writes, and is not something a candidate does in a loop. */
export const AGENT_ACTION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const AGENT_ACTION_RATE_LIMIT_MAX = 5;
