import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_MAX_ACTION_VACANCIES,
  type AgentActionProposal,
  type AgentToolName,
} from "../../shared/agent.js";
import { bulkApplyToVacancies, type BulkApplyResult } from "../applications/bulkApply.js";
import { GATE_REASON_CLAUSES, GENERIC_INELIGIBLE_REASON } from "../../shared/eligibilityReason.js";

/**
 * R4 — the executable tool registry, and the boundary between "the model said
 * something" and "something happened".
 *
 * THE MODEL NEVER EXECUTES. A tool call the model emits is a PROPOSAL: it is
 * validated, turned into a preview card built from the database, and returned to
 * the drawer to sit there until a human presses Approve. The only code in this
 * feature that writes is actions.ts, and it runs from its own authenticated
 * route — never from a model response.
 *
 * EVERY TOOL IS A THIN WRAPPER OVER AN ALREADY-AUTHORIZED FUNCTION. That is the
 * load-bearing property, not a style preference. queue_applications calls
 * bulkApplyToVacancies, which is exactly what the Opportunities page's Apply
 * button calls, so the Copilot cannot do anything a candidate could not already
 * do by clicking. It inherits every gate — rate_and_abuse_controls (the 25/24h
 * cap), automation_authorization, verified_facts, role_match, application_support
 * — because it goes through the same single funnel rather than inserting rows.
 *
 * DENIED, PERMANENTLY, AND NOT BECAUSE THEY ARE UNIMPLEMENTED. These have no
 * entry here and must never acquire one without a fresh founder decision:
 *
 *   * Sending email (sendFollowUpDraft) — irreversible, and it speaks to a third
 *     party as the candidate. A mis-issued follow-up cannot be unsent.
 *   * Submitting an application — the worker's job, behind the review gate.
 *   * Cancelling a subscription or any billing change — money, and a one-click
 *     path from a conversational nudge to a cancelled plan is a trap.
 *   * Deleting anything, anywhere.
 *   * Credential or OAuth changes — the mailbox and ATS keys are the crown
 *     jewels, and sanitize.ts's own threat model names token disclosure and
 *     permission changes as the things the model must not be able to reach.
 *   * Anything admin or moderator scoped. The Copilot runs as the candidate and
 *     its client is service-role; a single missing ownership check would turn a
 *     chat message into privilege escalation.
 *
 * The whitelist in shared/agent.ts is the enforcement; this comment is only the
 * reasoning.
 */

/** Declared so a reviewer can see the list in one place. Not consulted at runtime — AGENT_TOOL_NAMES is. */
export const AGENT_DENIED_ACTIONS = [
  "send_follow_up_email",
  "submit_application",
  "cancel_subscription",
  "delete_record",
  "change_credentials",
  "admin_action",
] as const;

/** Same shape as the route's UUID_PATTERN; kept local because that one is not exported. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QueueApplicationsArgs {
  vacancyIds: string[];
}

export interface AgentToolPreview {
  /** Server-built heading. Never the model's words. */
  title: string;
  /** One entry per line of the card body, resolved from the database. */
  lines: string[];
  confirmLabel: string;
}

export type AgentToolOutcome =
  | { kind: "executed"; summary: string; detail: unknown }
  /**
   * The run reached the gates and every job was refused by one. NOT a failure —
   * the system did its job — but not a success either, and the distinction is
   * the whole point of this variant: the tool ran and queued nothing, so no
   * write happened and the UI must not report completion.
   */
  | { kind: "blocked"; summary: string; detail: unknown }
  /** Infrastructure failure only — nothing ran. */
  | { kind: "failed"; message: string };

export type AgentArgsParseResult<Args> = { ok: true; args: Args } | { ok: false; message: string };

/**
 * Generic over its argument type so a tool's parse/summarize/execute agree on
 * one shape. THE REGISTRY IS HOMOGENEOUS FOR NOW — with a single tool, every
 * entry takes QueueApplicationsArgs. A second tool with a different argument
 * shape means widening the map's value type to a union and narrowing inside
 * actions.ts's dispatch; the generics are here so that change stays local.
 */
export interface AgentToolDefinition<Args> {
  name: AgentToolName;
  /** Sent to the model verbatim. Says what the tool does AND that it needs approval. */
  description: string;
  parameters: Record<string, unknown>;
  parse(raw: unknown): AgentArgsParseResult<Args>;
  summarize(client: SupabaseClient, args: Args, candidateId: string): Promise<AgentToolPreview>;
  execute(client: SupabaseClient, args: Args, candidateId: string): Promise<AgentToolOutcome>;
}

interface VacancyRow {
  id: string;
  raw_title: string | null;
  companies: { displayed_name?: string | null } | null;
}

/**
 * Resolves vacancy labels from the database, not from the model.
 *
 * This is why summarize is async and takes a client: the card a candidate reads
 * before approving must name the real company. A model that has been talked into
 * proposing a vacancy id it invented cannot also supply the label that would make
 * the proposal look legitimate.
 *
 * A missing id is NOT dropped here — it is rendered as "not a vacancy in
 * JobBeacon", and the caller refuses the whole proposal before it becomes an
 * approvable card, so the candidate never sees an Approve button for a job that
 * does not exist.
 */
async function loadVacancyLabels(
  client: SupabaseClient,
  vacancyIds: readonly string[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();

  if (vacancyIds.length === 0) {
    return labels;
  }

  const { data, error } = await client
    .from("vacancies")
    .select("id, raw_title, companies (displayed_name)")
    .in("id", [...vacancyIds]);

  if (error) {
    throw error;
  }

  for (const row of (data ?? []) as VacancyRow[]) {
    const title = row.raw_title?.trim() || "Untitled role";
    const company = row.companies?.displayed_name?.trim() ?? "";

    labels.set(row.id, company === "" ? title : title + " at " + company);
  }

  return labels;
}

export function vacancyLabelOrUnknown(labels: Map<string, string>, vacancyId: string): string {
  return labels.get(vacancyId) ?? "Not a vacancy in JobBeacon";
}

function parseQueueApplicationsArgs(raw: unknown): AgentArgsParseResult<QueueApplicationsArgs> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "arguments must be an object." };
  }

  const vacancyIds = (raw as { vacancyIds?: unknown }).vacancyIds;

  if (!Array.isArray(vacancyIds) || vacancyIds.length === 0) {
    return { ok: false, message: "vacancyIds must be a non-empty array." };
  }

  if (vacancyIds.length > AGENT_MAX_ACTION_VACANCIES) {
    return {
      ok: false,
      message: "vacancyIds must contain at most " + AGENT_MAX_ACTION_VACANCIES + " entries.",
    };
  }

  if (!vacancyIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    return { ok: false, message: "Every vacancyId must be a valid vacancy id." };
  }

  // Deduplicated here as well as inside bulkApplyToVacancies, so the preview and
  // the button label cannot promise one more action than will actually run.
  return { ok: true, args: { vacancyIds: [...new Set(vacancyIds as string[])] } };
}

/**
 * Plain-language wording for a gate reason code.
 *
 * WHY NOT THE RAW CODE. "NO_ADAPTER_REGISTERED_FOR_SOURCE" is accurate and
 * useless to the person reading it — the Copilot's audience is a job seeker, not
 * an operator. The codes still travel in the structured detail for logs and
 * support; only the primary copy is translated. An unrecognised code falls back
 * to the generic eligibility sentence rather than leaking the identifier.
 */

/** Distinct plain-language reasons across every blocked outcome, in first-seen order. */
export function describeBlockingGates(result: BulkApplyResult): string[] {
  const seen = new Set<string>();

  for (const outcome of result.outcomes) {
    if (outcome.status !== "blocked") {
      continue;
    }

    for (const gate of outcome.blockingGates) {
      seen.add(
        (gate.reasonCode !== null && GATE_REASON_CLAUSES[gate.reasonCode]) || GENERIC_INELIGIBLE_REASON,
      );
    }
  }

  return [...seen];
}

/**
 * The sentence a candidate reads after approving.
 *
 * WHY THIS IS NOT JUST A COUNT. "Queued 0 of 3" reads like a transient failure,
 * so a candidate retries an action that cannot work. Naming the reason replaces
 * that dead end with an explanation. Genuine partial success keeps both numbers,
 * because there the distinction between queued and blocked is the useful part.
 */
export function summarizeBulkApply(result: BulkApplyResult): string {
  if (result.queued === 0 && result.blocked > 0) {
    const reasons = describeBlockingGates(result);
    const detail = reasons.length > 0 ? " (" + reasons.join("; ") + ")" : "";

    return "No applications queued. Automatic applications aren't available for these jobs yet." + detail;
  }

  const parts = ["Queued " + result.queued + " of " + result.requested + "."];

  if (result.blocked > 0) {
    parts.push(result.blocked + " blocked by eligibility gates.");
  }

  if (result.errors > 0) {
    parts.push(result.errors + " failed.");
  }

  return parts.join(" ");
}

const QUEUE_APPLICATIONS: AgentToolDefinition<QueueApplicationsArgs> = {
  name: "queue_applications",

  description:
    "Propose queuing one or more job vacancies for application. The candidate must approve " +
    "the proposal in the app before anything is queued. Queuing is not submitting: every " +
    "vacancy still passes the normal eligibility and rate gates, so some may be blocked.",

  parameters: {
    type: "object",
    properties: {
      vacancyIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: AGENT_MAX_ACTION_VACANCIES,
        description:
          "The ids of the vacancies to queue, taken from the CANDIDATE CONTEXT. Never invent an id.",
      },
    },
    required: ["vacancyIds"],
    additionalProperties: false,
  },

  parse: parseQueueApplicationsArgs,

  async summarize(client, args, _candidateId) {
    const labels = await loadVacancyLabels(client, args.vacancyIds);
    const count = args.vacancyIds.length;

    return {
      title: count === 1 ? "Queue this application" : "Queue " + count + " applications",
      lines: args.vacancyIds.map((id) => vacancyLabelOrUnknown(labels, id)),
      confirmLabel: count === 1 ? "Queue application" : "Queue " + count + " applications",
    };
  },

  async execute(client, args, candidateId) {
    try {
      // THE STALE CASE IS HANDLED BY CLASSIFYING THE RESULT, NOT BY PRE-EMPTING
      // THE RUN. An earlier draft called loadQueueCapability here first and
      // returned "blocked" when it was false. That was wrong twice over: it
      // short-circuited past bulkApplyToVacancies, so genuine infrastructure
      // failures were reported as "no source supports this" instead of failing
      // loudly; and it made the honest outcome depend on a second read of data
      // the eligibility gates already read authoritatively.
      //
      // A stale card needs no special path. The gates are evaluated per vacancy
      // at execution time regardless, so a policy that disappeared is caught by
      // evaluateSourcePolicy/evaluateApplicationSupport and comes back as
      // blocked outcomes — which the classification below turns into an honest
      // "blocked", with the real per-vacancy reasons attached.
      const result = await bulkApplyToVacancies(client, {
        candidateId,
        vacancyIds: args.vacancyIds,
      });

      // ZERO QUEUED IS NOT COMPLETION. Reporting it as "executed" is what made
      // the card render as done after queueing nothing.
      if (result.queued === 0 && result.blocked > 0) {
        return { kind: "blocked", summary: summarizeBulkApply(result), detail: result };
      }

      return { kind: "executed", summary: summarizeBulkApply(result), detail: result };
    } catch (error) {
      return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  },
};

export const AGENT_TOOLS: ReadonlyMap<AgentToolName, AgentToolDefinition<QueueApplicationsArgs>> =
  new Map([[QUEUE_APPLICATIONS.name, QUEUE_APPLICATIONS]]);

export function getAgentTool(name: string): AgentToolDefinition<QueueApplicationsArgs> | undefined {
  return AGENT_TOOLS.get(name as AgentToolName);
}

export interface AgentModelTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * The tools advertised to the model.
 *
 * Derived from the registry rather than written out again, so a tool that exists
 * is offerable and a tool that does not cannot be offered — the two cannot drift
 * into the state where the model proposes something with no implementation.
 */
export function agentToolDescriptors(capability?: { canQueue: boolean }): AgentModelTool[] {
  // WITHHELD WHEN IT CANNOT SUCCEED. Offering queue_applications while no source
  // can queue produces an Approve button that always ends at "0 queued" — the
  // model cannot know that, so the server must not put the option in front of
  // it. An omitted capability keeps the old behaviour of advertising everything,
  // which is what the descriptor tests assert; callers that have resolved the
  // capability pass it.
  if (capability !== undefined && !capability.canQueue) {
    return [];
  }

  return [...AGENT_TOOLS.values()].map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export type AgentProposalBuildResult =
  | { ok: true; proposal: AgentActionProposal }
  | { ok: false; reason: string };

/**
 * Validates a model tool call and turns it into a card, or refuses it.
 *
 * THE VACANCY-EXISTENCE CHECK IS THE POINT. Before a candidate is shown a button,
 * every id the model named must resolve to a real vacancy — otherwise the model
 * could get an Approve button rendered for a job it invented, and the preview
 * would be the only thing standing between a hallucination and a click. A
 * proposal naming anything unknown is refused WHOLE rather than partly, because
 * a card listing three jobs where one is imaginary is worse than no card.
 *
 * Lives here rather than in chat.ts so that all knowledge of one tool's argument
 * shape stays in the module that defines it; chat.ts only ever sees a proposal.
 */
export async function buildAgentProposal(
  client: SupabaseClient,
  name: string,
  rawArguments: unknown,
  candidateId: string,
  capability?: { canQueue: boolean },
): Promise<AgentProposalBuildResult> {
  const tool = getAgentTool(name);

  if (!tool) {
    return { ok: false, reason: "unknown tool" };
  }

  // THE STALE-PROPOSAL GUARD. The capability is computed once per chat request
  // and passed in, so this costs no extra query. It matters even though the tool
  // is withheld when it is false: a model can still emit a call for a tool it
  // was not offered, and a transcript opened before a policy changed can carry
  // an old card. Refusing here means no Approve button is ever rendered for an
  // action that is known to queue nothing.
  if (tool.name === "queue_applications" && capability !== undefined && !capability.canQueue) {
    return { ok: false, reason: "no source supports automated application" };
  }

  const parsed = tool.parse(rawArguments);

  if (!parsed.ok) {
    return { ok: false, reason: parsed.message };
  }

  const labels = await loadVacancyLabels(client, parsed.args.vacancyIds);
  const missing = parsed.args.vacancyIds.filter((id) => !labels.has(id));

  if (missing.length > 0) {
    return { ok: false, reason: "proposal named a vacancy that does not exist" };
  }

  const preview = await tool.summarize(client, parsed.args, candidateId);

  return {
    ok: true,
    proposal: {
      tool: tool.name,
      title: preview.title,
      lines: preview.lines,
      confirmLabel: preview.confirmLabel,
      arguments: { vacancyIds: parsed.args.vacancyIds },
    },
  };
}
