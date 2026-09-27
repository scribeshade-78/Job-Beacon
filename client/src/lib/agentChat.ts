import {
  AGENT_MAX_HISTORY_TURNS,
  type AgentActionProposal,
  type AgentChatMessage,
  type AgentChatRole,
  type AgentModelId,
} from "../../../shared/agent";

/**
 * AI Career Copilot — the client's calls to /api/agent/chat and
 * /api/agent/actions/execute, and the session-only transcript store behind the
 * drawer.
 *
 * Calls the server rather than OpenRouter directly: the provider key is
 * server-held, and the server is what resolves the candidate's context from the
 * verified token. Nothing the client sends describes the candidate, so nothing
 * here can influence what the model is told about them.
 *
 * SESSION-ONLY, BY DECISION. There is no table and no migration; the transcript
 * lives in this module's memory and is gone on reload. Module-level rather than
 * component state for the same reason interviewPrep.ts's cache is: the drawer
 * unmounts when it closes, so state that died with it could not survive the
 * close/reopen cycle the History button exists for.
 *
 * R4 ADDS TWO KINDS OF SEND, AND THEY ARE NOT THE SAME. requestAgentChat asks
 * for an answer and may come back with PROPOSALS — suggestions that have done
 * nothing. requestAgentAction is the only call that changes anything, and
 * nothing in this module invokes it on its own: the drawer calls it from a click
 * handler and nowhere else.
 */

export type AgentChatRequestResult =
  | { kind: "success"; message: string; model: string; proposals: AgentActionProposal[] }
  /** A 4xx: the server refused on the merits (bad model, malformed transcript). Retrying the same request cannot help. */
  | { kind: "unavailable"; message: string }
  /** Network failure or 5xx — transient, so a retry is worth offering. */
  | { kind: "error"; message: string };

const GENERIC_FAILURE_MESSAGE = "The Copilot could not answer. Please try again.";

/** Reads the proposals array defensively — it is server output, but a truncated or older response must not crash the drawer. */
function readProposals(value: unknown): AgentActionProposal[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is AgentActionProposal => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }

    const record = entry as Record<string, unknown>;

    return (
      typeof record.tool === "string" &&
      typeof record.title === "string" &&
      Array.isArray(record.lines) &&
      typeof record.confirmLabel === "string" &&
      record.arguments !== null &&
      typeof record.arguments === "object"
    );
  });
}

export async function requestAgentChat(
  messages: AgentChatMessage[],
  accessToken: string,
  options: { model?: AgentModelId; fetchImpl?: typeof fetch } = {},
): Promise<AgentChatRequestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;

  try {
    response = await fetchImpl("/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
      },
      // Only the tail is sent: the server applies the same cap, and sending a
      // transcript the server will discard would be paying to upload it.
      body: JSON.stringify({
        messages: messages.slice(-AGENT_MAX_HISTORY_TURNS),
        ...(options.model ? { model: options.model } : {}),
      }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_FAILURE_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    // 4xx is the server declining on the merits; 5xx is infrastructure. Same
    // split interviewPrep.ts makes, for the same reason: only one of them
    // deserves a retry affordance.
    return response.status >= 400 && response.status < 500
      ? { kind: "unavailable", message }
      : { kind: "error", message };
  }

  try {
    const body = (await response.json()) as { message?: unknown; model?: unknown; proposals?: unknown };
    const proposals = readProposals(body.proposals);
    const message = typeof body.message === "string" ? body.message : "";

    // A purely tool-calling turn carries cards and no prose, so an empty message
    // is only a failure when there is nothing to render either.
    if (message.trim() === "" && proposals.length === 0) {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      message,
      model: typeof body.model === "string" ? body.model : "",
      proposals,
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

export type AgentActionRequestResult =
  | { kind: "executed"; tool: string; summary: string; detail: unknown }
  /** The server refused on the merits — a stale card, a tool that no longer exists, arguments it rejected. */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

const GENERIC_ACTION_MESSAGE = "That action could not be run. Please try again.";

/**
 * THE ONLY WRITE IN THE CLIENT.
 *
 * Called exclusively from an Approve button's click handler. The arguments are
 * the ones the server itself put on the proposal, echoed back untouched — the
 * server re-validates them regardless, so tampering here buys nothing.
 */
export async function requestAgentAction(
  tool: string,
  args: Record<string, unknown>,
  accessToken: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<AgentActionRequestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;

  try {
    response = await fetchImpl("/api/agent/actions/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
      },
      body: JSON.stringify({ tool, arguments: args }),
    });
  } catch {
    return { kind: "error", message: "Network error contacting the server." };
  }

  if (!response.ok) {
    let message = GENERIC_ACTION_MESSAGE;

    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        message = body.error;
      }
    } catch {
      // Fall back to the generic message.
    }

    return response.status >= 400 && response.status < 500
      ? { kind: "unavailable", message }
      : { kind: "error", message };
  }

  try {
    const body = (await response.json()) as { tool?: unknown; summary?: unknown; detail?: unknown };

    if (typeof body.summary !== "string" || body.summary.trim() === "") {
      return { kind: "error", message: GENERIC_ACTION_MESSAGE };
    }

    return {
      kind: "executed",
      tool: typeof body.tool === "string" ? body.tool : tool,
      summary: body.summary,
      detail: body.detail,
    };
  } catch {
    return { kind: "error", message: GENERIC_ACTION_MESSAGE };
  }
}

// ---------------------------------------------------------------------------
// The session store.
// ---------------------------------------------------------------------------

/** A proposal as it stands in the transcript, which is not the same as when it arrived. */
export type AgentProposalState = "pending" | "executing" | "done" | "dismissed" | "failed";

export interface AgentTranscriptProposal {
  proposal: AgentActionProposal;
  state: AgentProposalState;
  /** The server's summary once executed, or the reason it failed. Empty until then. */
  message: string;
}

export interface AgentTranscriptEntry {
  id: string;
  role: AgentChatRole;
  content: string;
  proposals: AgentTranscriptProposal[];
}

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: number;
  messages: AgentTranscriptEntry[];
}

export interface AgentStoreSnapshot {
  conversations: AgentConversation[];
  activeId: string | null;
}

/** Derives a conversation's label from its first user message. */
const TITLE_MAX_CHARS = 48;

export function deriveConversationTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");

  return trimmed.length <= TITLE_MAX_CHARS ? trimmed : trimmed.slice(0, TITLE_MAX_CHARS - 1) + "…";
}

const EMPTY_SNAPSHOT: AgentStoreSnapshot = { conversations: [], activeId: null };

let snapshot: AgentStoreSnapshot = EMPTY_SNAPSHOT;
let entryCounter = 0;
const listeners = new Set<() => void>();

function publish(next: AgentStoreSnapshot): void {
  // A NEW OBJECT EVERY TIME. useSyncExternalStore compares snapshots by
  // identity, so mutating the existing one would notify subscribers that
  // nothing had changed and React would skip the re-render.
  snapshot = next;

  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAgentStore(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function getAgentSnapshot(): AgentStoreSnapshot {
  return snapshot;
}

export function startNewConversation(now: number = Date.now()): string {
  const id = "conv-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const conversation: AgentConversation = { id, title: "New chat", createdAt: now, messages: [] };

  publish({ conversations: [conversation, ...snapshot.conversations], activeId: id });

  return id;
}

/** Returns the new entry's id, which the caller needs to update its proposals later. */
export function appendAgentTurn(
  role: AgentChatRole,
  content: string,
  proposals: AgentActionProposal[] = [],
): string {
  const activeId = snapshot.activeId;

  if (activeId === null) {
    return "";
  }

  entryCounter += 1;
  const entryId = "turn-" + entryCounter;

  const entry: AgentTranscriptEntry = {
    id: entryId,
    role,
    content,
    proposals: proposals.map((proposal) => ({ proposal, state: "pending" as const, message: "" })),
  };

  publish({
    activeId,
    conversations: snapshot.conversations.map((conversation) => {
      if (conversation.id !== activeId) {
        return conversation;
      }

      return {
        ...conversation,
        messages: [...conversation.messages, entry],
        // Named after the first thing the candidate asked, so the history list
        // reads as their questions rather than as "New chat" repeated.
        title:
          role === "user" && conversation.messages.length === 0
            ? deriveConversationTitle(content)
            : conversation.title,
      };
    }),
  });

  return entryId;
}

/** Moves one proposal to a new state and records the server's words for it. */
export function setProposalState(
  entryId: string,
  proposalIndex: number,
  state: AgentProposalState,
  message = "",
): void {
  const activeId = snapshot.activeId;

  if (activeId === null) {
    return;
  }

  publish({
    activeId,
    conversations: snapshot.conversations.map((conversation) => {
      if (conversation.id !== activeId) {
        return conversation;
      }

      return {
        ...conversation,
        messages: conversation.messages.map((entry) => {
          if (entry.id !== entryId) {
            return entry;
          }

          return {
            ...entry,
            proposals: entry.proposals.map((item, index) =>
              index === proposalIndex ? { ...item, state, message } : item,
            ),
          };
        }),
      };
    }),
  });
}

export function getActiveConversation(): AgentConversation | null {
  const activeId = snapshot.activeId;

  if (activeId === null) {
    return null;
  }

  return snapshot.conversations.find((conversation) => conversation.id === activeId) ?? null;
}

/**
 * The transcript as the API expects it.
 *
 * ENTRIES WITH NO PROSE ARE DROPPED. A purely tool-calling assistant turn has an
 * empty content string, and the server rejects an empty message outright — so
 * sending one would turn the next question into a 400. The cards stay on screen;
 * only the wire form omits them.
 */
export function toRequestMessages(conversation: AgentConversation | null): AgentChatMessage[] {
  if (conversation === null) {
    return [];
  }

  return conversation.messages
    .filter((entry) => entry.content.trim() !== "")
    .map((entry) => ({ role: entry.role, content: entry.content }));
}

export function selectConversation(id: string): void {
  if (!snapshot.conversations.some((conversation) => conversation.id === id)) {
    return;
  }

  publish({ conversations: snapshot.conversations, activeId: id });
}

/** Test-only: stops one case's transcript leaking into the next. */
export function resetAgentStore(): void {
  snapshot = EMPTY_SNAPSHOT;
  entryCounter = 0;
}
