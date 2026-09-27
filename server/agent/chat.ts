import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import {
  AGENT_MAX_HISTORY_TURNS,
  AGENT_MAX_MESSAGE_CHARS,
  isAgentModelId,
  type AgentChatMessage,
  type AgentModelId,
} from "../../shared/agent.js";
import { loadCandidateContext } from "./context.js";
import {
  buildAgentMessages,
  EmptyAgentReplyError,
  readAgentReply,
  readDefaultAgentModel,
} from "./chatPrompt.js";

/**
 * AI Career Copilot — the endpoint's application logic.
 *
 * Mirrors server/interview/interviewPrep.ts: one function returning a
 * discriminated result rather than throwing, so the route maps each outcome to
 * a status code without a try/catch per case, and every failure is a value the
 * tests can assert on.
 *
 * NO PERSISTENCE, matching the interview-prep precedent the founder chose:
 * nothing is written, so there is no new table, no migration, and no stored
 * copy of what a candidate asked. The transcript lives in the drawer for the
 * life of the page and is gone on reload.
 *
 * THE REQUEST BODY IS VALIDATED HERE, NOT IN THE ROUTE, because the bounds are
 * part of the feature's contract rather than of HTTP: the same parser is what
 * the tests exercise, and a second caller (a worker, a script) would get the
 * same limits for free.
 */

export type AgentChatResult =
  | { kind: "success"; message: string; model: AgentModelId }
  /** The model answered with nothing usable. A 502: the request was fine, the upstream reply was not. */
  | { kind: "empty_reply"; message: string }
  | { kind: "error"; message: string };

export type ParsedAgentChatRequest =
  | { ok: true; messages: AgentChatMessage[]; model: AgentModelId | undefined }
  | { ok: false; message: string };

const MAX_MESSAGE_CHARS_LABEL = String(AGENT_MAX_MESSAGE_CHARS);

/**
 * Validates an untrusted body into the shape the model call expects.
 *
 * Every rejection names the offending field, because a 400 that says only
 * "invalid request" leaves a client author guessing. An omitted model is NOT a
 * rejection — it is "use the configured default", which is the common case.
 */
export function parseAgentChatRequest(body: unknown): ParsedAgentChatRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const record = body as Record<string, unknown>;
  const rawMessages = record.messages;

  if (!Array.isArray(rawMessages)) {
    return { ok: false, message: "messages must be an array." };
  }

  if (rawMessages.length === 0) {
    return { ok: false, message: "messages must contain at least one message." };
  }

  if (rawMessages.length > AGENT_MAX_HISTORY_TURNS) {
    return {
      ok: false,
      message: "messages must contain at most " + AGENT_MAX_HISTORY_TURNS + " messages.",
    };
  }

  const messages: AgentChatMessage[] = [];

  for (let index = 0; index < rawMessages.length; index += 1) {
    const entry = rawMessages[index];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, message: "messages[" + index + "] must be an object." };
    }

    const { role, content } = entry as { role?: unknown; content?: unknown };

    if (role !== "user" && role !== "assistant") {
      return { ok: false, message: "messages[" + index + "].role must be 'user' or 'assistant'." };
    }

    if (typeof content !== "string" || content.trim() === "") {
      return { ok: false, message: "messages[" + index + "].content must be a non-empty string." };
    }

    if (content.length > AGENT_MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        message: "messages[" + index + "].content must be at most " + MAX_MESSAGE_CHARS_LABEL + " characters.",
      };
    }

    messages.push({ role, content });
  }

  // A transcript that ends on an assistant turn has nothing to answer, so this
  // is a malformed request rather than a question with an empty reply.
  if (messages[messages.length - 1].role !== "user") {
    return { ok: false, message: "messages must end with a user message." };
  }

  const rawModel = record.model;

  if (rawModel !== undefined && rawModel !== null) {
    if (!isAgentModelId(rawModel)) {
      return { ok: false, message: "model is not one of the available models." };
    }
  }

  return {
    ok: true,
    messages,
    model: isAgentModelId(rawModel) ? rawModel : undefined,
  };
}

export async function answerAgentChat(
  client: Pick<SupabaseClient, "from">,
  openaiClient: Pick<OpenAI, "chat">,
  params: { candidateId: string; messages: AgentChatMessage[]; model?: AgentModelId },
): Promise<AgentChatResult> {
  // The tail, not the head: a follow-up refers to what was just said, and the
  // cap exists so an unbounded transcript cannot inflate the prompt.
  const history = params.messages.slice(-AGENT_MAX_HISTORY_TURNS);
  const model = params.model ?? readDefaultAgentModel();

  try {
    const context = await loadCandidateContext(client, params.candidateId);
    const completion = await openaiClient.chat.completions.create({
      model,
      messages: buildAgentMessages(context, history),
    });

    return { kind: "success", message: readAgentReply(completion), model };
  } catch (error) {
    if (error instanceof EmptyAgentReplyError) {
      return {
        kind: "empty_reply",
        message: "The assistant returned an empty response. Please try again.",
      };
    }

    // resolveServiceClient throws when its env is unset, and a PostgREST or
    // provider failure lands here too — a 500 with the real reason beats a
    // silent misconfiguration.
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
