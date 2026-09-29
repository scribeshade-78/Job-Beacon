import type { SupabaseClient } from "@supabase/supabase-js";
import { isAgentToolName, type AgentToolName } from "../../shared/agent.js";
import { recordAuditEvent } from "../audit/log.js";
import { getAgentTool } from "./tools.js";

/**
 * R4 — executing an APPROVED action.
 *
 * This module is the only write path in the Copilot, and it is deliberately not
 * reachable from the chat route: a model response can produce a proposal, and
 * only a separate authenticated request carrying a human's approval reaches here.
 *
 * THE CLIENT-ECHOED PROPOSAL IS UNTRUSTED INPUT. Between the model proposing an
 * action and the candidate approving it, the arguments travel through the
 * browser and come back. Nothing about them is taken on faith: the tool name is
 * re-checked against the whitelist, the arguments are re-parsed by the tool's own
 * parser, and the tool resolves ownership from the verified candidate id itself.
 * The worst a tampered proposal can achieve is to request an action the candidate
 * was already entitled to perform — which is exactly the click they could have
 * made on the Opportunities page.
 *
 * WHY RE-VALIDATION IS THE WHOLE PROTECTION. There is no server-held proposal
 * record and no single-use nonce (no persistence, by decision). That means a
 * determined client can replay an approval. The defence is that every tool is
 * STATE-GUARDED OR IDEMPOTENT, which is now a RULE for adding one:
 * queue_applications reuses an existing active attempt and dedupes its ids, so
 * running it twice queues the work once. A future tool that could double-charge,
 * double-send or double-create is not eligible for this registry as it stands —
 * it would need the persisted-proposal design instead.
 *
 * EVERY OUTCOME IS AUDITED, including failures: an attempt to act is exactly the
 * thing an audit trail exists to record, and recordAuditEvent is documented as
 * never throwing, so an audit problem cannot mask an action that did happen.
 */

export type AgentActionExecutionResult =
  | { kind: "executed"; tool: AgentToolName; summary: string; detail: unknown }
  /**
   * The tool ran and every job was refused by an eligibility gate. Returned as
   * its own kind so the client cannot render it as a completed action: nothing
   * was written, and the summary explains why.
   */
  | { kind: "blocked"; tool: AgentToolName; summary: string; detail: unknown }
  /** The request itself was malformed, or named a tool that exists but rejected these arguments. */
  | { kind: "invalid_request"; message: string }
  /** A tool name outside AGENT_TOOL_NAMES — a tampered or stale client. */
  | { kind: "unknown_tool"; message: string }
  /** Infrastructure failure. The action did not happen. */
  | { kind: "failed"; message: string };

export type ParsedAgentActionRequest =
  | { ok: true; tool: AgentToolName; args: unknown }
  | { ok: false; message: string };

/**
 * Shape and whitelist only — no database access, so the route can refuse a bad
 * request before it costs a query, and so this half is testable on its own.
 */
export function parseAgentActionRequest(body: unknown): ParsedAgentActionRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const record = body as Record<string, unknown>;

  if (!isAgentToolName(record.tool)) {
    return { ok: false, message: "tool is not one of the available actions." };
  }

  return { ok: true, tool: record.tool, args: record.arguments ?? {} };
}

export async function executeAgentAction(
  client: SupabaseClient,
  params: { candidateId: string; tool: AgentToolName; args: unknown },
): Promise<AgentActionExecutionResult> {
  const tool = getAgentTool(params.tool);

  // Unreachable while AGENT_TOOL_NAMES and the registry agree, which a test
  // enforces — but a name in the whitelist with no implementation must refuse
  // rather than fall through to "nothing happened", which would read as success.
  if (!tool) {
    return { kind: "unknown_tool", message: "tool is not one of the available actions." };
  }

  const parsed = tool.parse(params.args);

  if (!parsed.ok) {
    return { kind: "invalid_request", message: parsed.message };
  }

  const outcome = await tool.execute(client, parsed.args, params.candidateId);

  // A gate refusal is its own audit action. Collapsing it into either
  // "executed" or "failed" would make the trail lie in one direction or the
  // other: nothing was written, but nothing broke either.
  const auditAction =
    outcome.kind === "executed"
      ? "agent.action.executed"
      : outcome.kind === "blocked"
        ? "agent.action.blocked"
        : "agent.action.failed";

  await recordAuditEvent(client, {
    actorId: params.candidateId,
    actorRole: "candidate",
    action: auditAction,
    entityType: "agent_action",
    entityId: null,
    summary:
      outcome.kind === "failed"
        ? tool.name + ": " + outcome.message
        : tool.name + ": " + outcome.summary,
    previousValues: null,
    // The REQUESTED arguments are recorded alongside the result, so the trail
    // shows what was asked for and not only what came back.
    newValues:
      outcome.kind === "failed"
        ? { arguments: parsed.args }
        : { arguments: parsed.args, result: outcome.detail },
    reason: outcome.kind === "failed" ? outcome.message : null,
  });

  if (outcome.kind === "executed") {
    return { kind: "executed", tool: tool.name, summary: outcome.summary, detail: outcome.detail };
  }

  if (outcome.kind === "blocked") {
    return { kind: "blocked", tool: tool.name, summary: outcome.summary, detail: outcome.detail };
  }

  return { kind: "failed", message: outcome.message };
}
