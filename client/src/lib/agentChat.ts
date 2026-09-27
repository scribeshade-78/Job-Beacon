import {
  AGENT_MAX_HISTORY_TURNS,
  type AgentChatMessage,
  type AgentChatRole,
  type AgentModelId,
} from "../../../shared/agent";

/**
 * AI Career Copilot — the client's call to /api/agent/chat, and the session-only
 * transcript store behind the drawer.
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
 */

export type AgentChatRequestResult =
  | { kind: "success"; message: string; model: string }
  /** A 4xx: the server refused on the merits (bad model, malformed transcript). Retrying the same request cannot help. */
  | { kind: "unavailable"; message: string }
  /** Network failure or 5xx — transient, so a retry is worth offering. */
  | { kind: "error"; message: string };

const GENERIC_FAILURE_MESSAGE = "The Copilot could not answer. Please try again.";

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
    const body = (await response.json()) as { message?: unknown; model?: unknown };

    if (typeof body.message !== "string" || body.message.trim() === "") {
      return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
    }

    return {
      kind: "success",
      message: body.message,
      model: typeof body.model === "string" ? body.model : "",
    };
  } catch {
    return { kind: "error", message: GENERIC_FAILURE_MESSAGE };
  }
}

// ---------------------------------------------------------------------------
// The session store.
// ---------------------------------------------------------------------------

export interface AgentConversation {
  id: string;
  title: string;
  createdAt: number;
  messages: AgentChatMessage[];
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

export function appendAgentTurn(role: AgentChatRole, content: string): void {
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

      const messages: AgentChatMessage[] = [...conversation.messages, { role, content }];

      return {
        ...conversation,
        messages,
        // Named after the first thing the candidate asked, so the history list
        // reads as their questions rather than as "New chat" repeated.
        title:
          role === "user" && conversation.messages.length === 0
            ? deriveConversationTitle(content)
            : conversation.title,
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

export function selectConversation(id: string): void {
  if (!snapshot.conversations.some((conversation) => conversation.id === id)) {
    return;
  }

  publish({ conversations: snapshot.conversations, activeId: id });
}

/** Test-only: stops one case's transcript leaking into the next. */
export function resetAgentStore(): void {
  snapshot = EMPTY_SNAPSHOT;
}
