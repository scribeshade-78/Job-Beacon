import type { SupabaseClient } from "@supabase/supabase-js";
import {
  countByPipelineStage,
  matchesPipelineStage,
  PIPELINE_STAGES,
  pipelineStageOf,
  type PipelineStageId,
} from "../../shared/pipelineStages.js";
import {
  bulkApplyToVacancies,
  MAX_BULK_APPLY_VACANCIES,
  type BulkApplyResult,
} from "../applications/bulkApply.js";
import { resolveApplicationAdapter } from "../applications/adapters/registry.js";
import { listIntakeAdapters } from "../intake/adapters/registry.js";
import { runIntake, type RunIntakeDeps } from "../intake/intake.js";

/**
 * Mini-Phase 9/10 — the MCP server's tools.
 *
 * Kept out of index.ts (which owns the process and the stdio transport) so
 * the queries and the stage classification are testable without spawning a
 * server or speaking JSON-RPC.
 *
 * TWO READ TOOLS AND TWO WRITE TOOLS, AND THE BOUNDARIES ARE THE POINT.
 * get_candidate_pipeline and get_opportunity_details only read.
 * queue_applications enqueues — it creates application_plans rows and, when
 * the gates pass, a pending application_attempts row.
 * discover_live_jobs (Task W) writes VACANCIES: it fetches real postings from a
 * live source and ingests them, so the pipeline can be fed without hand-seeded
 * fixture rows. It is a different kind of write from queue_applications and the
 * two are not interchangeable — see that tool's own comment.
 *
 * It is deliberately NOT able to bypass anything. It calls the same
 * bulkApplyToVacancies the HTTP route calls, which calls the same
 * planApplication the worker and the daemon call, so every one of the nine
 * eligibility gates still runs: an agent cannot queue a vacancy that
 * rate_and_abuse_controls would refuse (the 25/24h cap), nor one whose
 * automation_authorization is paused, nor one with no registered adapter. The
 * agent gets the same per-vacancy gate outcomes a human clicking "Apply to
 * these" gets, including the honest "0 queued" when nothing is supported.
 *
 * What is NOT exposed, and should not be: submitting. No tool drives a
 * portal, drains the queue, or changes source_policies — those stay behind
 * the worker and the operator, not an unattended agent.
 */

export class CandidateResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateResolutionError";
  }
}

export class QueueApplicationsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueApplicationsInputError";
  }
}

export class VacancyNotFoundError extends Error {
  constructor(vacancyId: string) {
    super(`No vacancies row exists for vacancy_id "${vacancyId}".`);
    this.name = "VacancyNotFoundError";
  }
}

/**
 * Resolves which candidate to report on.
 *
 * candidate_id is optional so the common single-candidate development setup
 * needs no argument — but it is NEVER guessed when ambiguous. With more than
 * one candidate the tool refuses and names the count, rather than silently
 * picking the first row and reporting one person's pipeline as if it were
 * everyone's.
 */
export async function resolveCandidateId(
  client: Pick<SupabaseClient, "from">,
  requested?: string,
): Promise<string> {
  if (requested) {
    const { data, error } = await client
      .from("candidate_profiles")
      .select("id")
      .eq("id", requested)
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (!data) {
      throw new CandidateResolutionError(`No candidate_profiles row exists for candidate_id "${requested}".`);
    }

    return (data as { id: string }).id;
  }

  const { data, error } = await client.from("candidate_profiles").select("id");

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as Array<{ id: string }>;

  if (rows.length === 0) {
    throw new CandidateResolutionError(
      "No candidate_profiles rows exist, so there is no pipeline to report. Pass candidate_id once one exists.",
    );
  }

  if (rows.length > 1) {
    throw new CandidateResolutionError(
      `candidate_id is required: ${rows.length} candidates exist, so the tool will not guess which pipeline to report.`,
    );
  }

  return rows[0].id;
}

const PIPELINE_SELECT =
  "id, vacancy_id, gate_results, created_at, vacancies (raw_title, authoritative_url, trust_status, source_code), application_attempts (id, status, attempts, max_attempts, last_error, created_at, updated_at, messages (id, response_classifications (category)))";

interface PlanRow {
  id: string;
  vacancy_id: string;
  gate_results: { eligible: boolean } | null;
  created_at: string;
  vacancies: { raw_title: string; authoritative_url: string; trust_status: string | null; source_code: string } | null;
  application_attempts: Array<{
    id: string;
    status: string;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
    messages: Array<{ response_classifications: Array<{ category: string }> | null }> | null;
  }> | null;
}

/**
 * Response categories for one plan, deduplicated across its messages.
 * response_classifications has a unique index on message_id, so a message
 * carries at most one classification — there is no "latest of several" to
 * resolve here.
 */
function responseCategoriesOf(plan: PlanRow): string[] {
  const categories: string[] = [];

  for (const attempt of plan.application_attempts ?? []) {
    for (const message of attempt.messages ?? []) {
      for (const classification of message.response_classifications ?? []) {
        if (!categories.includes(classification.category)) {
          categories.push(classification.category);
        }
      }
    }
  }

  return categories;
}

export interface PipelineApplicationSummary {
  planId: string;
  vacancyId: string;
  vacancyTitle: string;
  vacancyUrl: string;
  sourceCode: string;
  trustStatus: string | null;
  eligible: boolean;
  /**
   * Deliberately the same { status } shape shared/pipelineStages.ts declares,
   * so countByPipelineStage/matchesPipelineStage run on these summaries
   * directly. A flattened string[] would read marginally better in the JSON
   * but would force a second, driftable mapping before classification.
   */
  attempts: Array<{ status: string }>;
  lastError: string | null;
  responseCategories: string[];
}

export interface PipelineStageSummary {
  stage: PipelineStageId;
  label: string;
  count: number;
  applications: PipelineApplicationSummary[];
}

export interface CandidatePipelineResult {
  candidateId: string;
  totalApplications: number;
  /** One entry per PIPELINE_STAGES, in chronological order. Counts sum to totalApplications. */
  stages: PipelineStageSummary[];
}

export async function getCandidatePipeline(
  client: Pick<SupabaseClient, "from">,
  options: { candidateId?: string } = {},
): Promise<CandidatePipelineResult> {
  const candidateId = await resolveCandidateId(client, options.candidateId);

  const { data, error } = await client
    .from("application_plans")
    .select(PIPELINE_SELECT)
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  const plans = (data ?? []) as unknown as PlanRow[];

  const summaries: PipelineApplicationSummary[] = plans.map((plan) => ({
    planId: plan.id,
    vacancyId: plan.vacancy_id,
    vacancyTitle: plan.vacancies?.raw_title ?? "",
    vacancyUrl: plan.vacancies?.authoritative_url ?? "",
    sourceCode: plan.vacancies?.source_code ?? "",
    trustStatus: plan.vacancies?.trust_status ?? null,
    eligible: plan.gate_results?.eligible ?? false,
    attempts: (plan.application_attempts ?? []).map((attempt) => ({ status: attempt.status })),
    lastError:
      (plan.application_attempts ?? []).map((attempt) => attempt.last_error).find((value) => value !== null) ?? null,
    responseCategories: responseCategoriesOf(plan),
  }));

  const counts = countByPipelineStage(summaries);

  return {
    candidateId,
    totalApplications: summaries.length,
    // Every stage is returned even at zero, so an agent reads "no interviews
    // yet" rather than having to infer absence from a missing key.
    stages: PIPELINE_STAGES.map(({ id, label }) => ({
      stage: id,
      label,
      count: counts[id],
      applications: summaries.filter((summary) => matchesPipelineStage(summary, id)),
    })),
  };
}

export interface BlockingGate {
  gate: string;
  reasonCode: string | null;
}

export interface OpportunityDetailsResult {
  candidateId: string;
  vacancyId: string;
  /** The complete vacancies row, all columns. */
  vacancy: Record<string, unknown>;
  company: Record<string, unknown> | null;
  /**
   * The candidate's plan for this vacancy, if one exists. gate_results is
   * frozen at plan creation for an ELIGIBLE verdict and re-evaluated for an
   * ineligible one — see applicationEngine.ts's reevaluateIneligiblePlan.
   */
  plan: {
    planId: string;
    eligible: boolean;
    blockingGates: BlockingGate[];
    gateResults: Record<string, unknown>;
  } | null;
  attempts: Array<{ id: string; status: string; attempts: number; maxAttempts: number; lastError: string | null }>;
  /** Present when plan is null, so a caller knows why there are no gates. */
  planNote?: string;
}

export async function getOpportunityDetails(
  client: Pick<SupabaseClient, "from">,
  options: { vacancyId: string; candidateId?: string },
): Promise<OpportunityDetailsResult> {
  const candidateId = await resolveCandidateId(client, options.candidateId);

  const { data: vacancy, error: vacancyError } = await client
    .from("vacancies")
    .select("*")
    .eq("id", options.vacancyId)
    .maybeSingle();

  if (vacancyError) {
    throw vacancyError;
  }
  if (!vacancy) {
    throw new VacancyNotFoundError(options.vacancyId);
  }

  const vacancyRow = vacancy as Record<string, unknown>;

  let company: Record<string, unknown> | null = null;

  if (typeof vacancyRow.company_id === "string") {
    const { data: companyRow, error: companyError } = await client
      .from("companies")
      .select("*")
      .eq("id", vacancyRow.company_id)
      .maybeSingle();

    if (companyError) {
      throw companyError;
    }

    company = (companyRow as Record<string, unknown> | null) ?? null;
  }

  const { data: planRow, error: planError } = await client
    .from("application_plans")
    .select("id, gate_results")
    .eq("candidate_id", candidateId)
    .eq("vacancy_id", options.vacancyId)
    .maybeSingle();

  if (planError) {
    throw planError;
  }

  if (!planRow) {
    return {
      candidateId,
      vacancyId: options.vacancyId,
      vacancy: vacancyRow,
      company,
      plan: null,
      attempts: [],
      planNote:
        "No application_plans row exists for this candidate and vacancy, so no gate results have been evaluated yet.",
    };
  }

  const plan = planRow as {
    id: string;
    gate_results: { eligible: boolean; gates?: Record<string, { status: string; reasonCode?: string }> };
  };

  const { data: attemptRows, error: attemptsError } = await client
    .from("application_attempts")
    .select("id, status, attempts, max_attempts, last_error")
    .eq("application_plan_id", plan.id);

  if (attemptsError) {
    throw attemptsError;
  }

  const gates = plan.gate_results?.gates ?? {};
  const blockingGates: BlockingGate[] = Object.entries(gates)
    .filter(([, result]) => result.status === "fail")
    .map(([gate, result]) => ({ gate, reasonCode: result.reasonCode ?? null }));

  return {
    candidateId,
    vacancyId: options.vacancyId,
    vacancy: vacancyRow,
    company,
    plan: {
      planId: plan.id,
      eligible: plan.gate_results?.eligible ?? false,
      blockingGates,
      gateResults: plan.gate_results as unknown as Record<string, unknown>,
    },
    attempts: (
      (attemptRows ?? []) as Array<{
        id: string;
        status: string;
        attempts: number;
        max_attempts: number;
        last_error: string | null;
      }>
    ).map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      attempts: attempt.attempts,
      maxAttempts: attempt.max_attempts,
      lastError: attempt.last_error,
    })),
  };
}

/**
 * Enqueues applications for the given vacancies — the MCP equivalent of the
 * Opportunities page's "Apply to X loaded matches" button.
 *
 * Delegates wholesale to bulkApplyToVacancies rather than reimplementing the
 * loop, so the gates, the per-vacancy error isolation and the limit are the
 * same code path the HTTP route uses. The limit is imported from that module
 * rather than restated, so MCP and HTTP cannot drift apart.
 *
 * Input is validated here as well as in the tool schema because this function
 * is directly callable: a min/max on the Zod schema protects the MCP surface,
 * not the function.
 */
export async function queueApplications(
  client: SupabaseClient,
  options: { vacancyIds: readonly string[]; candidateId?: string },
): Promise<BulkApplyResult> {
  if (options.vacancyIds.length === 0) {
    throw new QueueApplicationsInputError("vacancy_ids must contain at least one vacancy id.");
  }

  if (options.vacancyIds.length > MAX_BULK_APPLY_VACANCIES) {
    throw new QueueApplicationsInputError(
      `vacancy_ids must contain at most ${MAX_BULK_APPLY_VACANCIES} entries.`,
    );
  }

  const candidateId = await resolveCandidateId(client, options.candidateId);

  return bulkApplyToVacancies(client, { candidateId, vacancyIds: options.vacancyIds });
}

/** Exported for the tests: the classification this module relies on. */
export { pipelineStageOf };

/* ------------------------------------------------------------------------- *
 * Task W — discover_live_jobs.
 *
 * The third write tool, and the first that WRITES VACANCIES rather than
 * applications. It is the door an agent uses to stop depending on hand-seeded
 * fixture rows: ask for real postings matching a query, get them ingested,
 * scored and visible.
 *
 * It cannot bypass a gate. runIntake refuses a source whose kill_switch is on
 * or whose discovery_allowed is false, exactly as the scheduled ingestion
 * worker does, so an agent cannot use this to fetch from a source an operator
 * has switched off. What it does NOT have is an eligibility gate, because
 * discovery is not application: these vacancies land in the table and are
 * subject to the same nine gates as everything else when someone tries to apply.
 *
 * THE HONEST HEADLINE ABOUT THESE VACANCIES, reported on every result so an
 * agent is not left to discover it by failure: for a source with no registered
 * submission adapter, queue_applications will refuse every one of them with
 * NO_ADAPTER_REGISTERED_FOR_SOURCE. Discovery and application are different
 * capabilities over the same table, and this tool only provides the first.
 * ------------------------------------------------------------------------- */

export class IntakeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeInputError";
  }
}

export interface DiscoverLiveJobsInput {
  sourceCode?: string;
  search?: string;
  limit?: number;
}

export interface DiscoverLiveJobsResult {
  sourceCode: string;
  displayName: string;
  /** The attribution the source's terms require to be carried with its data. */
  attribution: string;
  search: string | null;
  received: number;
  skippedByAdapter: number;
  ingested: number;
  /**
   * How many ingested vacancies landed in each trust status. The scorer decides
   * per vacancy, so this is a distribution rather than one value — a run can
   * legitimately produce VERIFIED_INCOMPLETE for most rows and FLAGGED for the
   * ones it found something wrong with.
   */
  trustStatusCounts: Record<string, number>;
  /** True when a submission adapter exists for this source, so queueing could succeed. */
  applicationSupported: boolean;
  applicationSupportNote: string;
  /** Every vacancy written by this call, ready to be passed to queue_applications. */
  vacancies: Array<{ vacancyId: string; title: string; companyName: string; outcome: string; trustStatus?: string }>;
  dataNote: string;
  durationMs: number;
}

/**
 * Discovery and application are separate capabilities. Saying so on the result
 * is cheaper than letting an agent learn it from a wall of blocked gate
 * outcomes — and it is the same fact, read from the same registry the
 * application_support gate reads, not a hardcoded list.
 */
function applicationSupportFor(sourceCode: string): { supported: boolean; note: string } {
  const adapter = resolveApplicationAdapter(sourceCode);

  if (adapter.isAutomatedSubmissionSupported) {
    return {
      supported: true,
      note: "A submission adapter exists for this source, so queue_applications can queue these.",
    };
  }

  return {
    supported: false,
    note: "No submission adapter is registered for this source, so queue_applications will reject every vacancy below with NO_ADAPTER_REGISTERED_FOR_SOURCE. They are discoverable and readable, not appliable.",
  };
}

export async function discoverLiveJobs(
  client: SupabaseClient,
  input: DiscoverLiveJobsInput = {},
  deps: RunIntakeDeps = {},
): Promise<DiscoverLiveJobsResult> {
  const registered = listIntakeAdapters();

  if (registered.length === 0) {
    throw new IntakeInputError("No intake adapters are registered, so there is nothing to discover from.");
  }

  // Defaulted only when unambiguous. With more than one registered source the
  // caller must choose, for the same reason resolveCandidateId refuses to guess:
  // reporting one source's results as though they were the requested ones is
  // worse than an error naming the options.
  let sourceCode = input.sourceCode;

  if (!sourceCode) {
    if (registered.length > 1) {
      throw new IntakeInputError(
        `source_code is required: ${registered.length} intake sources are registered (${registered
          .map((adapter) => adapter.sourceCode)
          .join(", ")}), so the tool will not guess which one to query.`,
      );
    }

    sourceCode = registered[0].sourceCode;
  }

  if (input.limit !== undefined && (!Number.isFinite(input.limit) || input.limit < 1)) {
    throw new IntakeInputError("limit must be a positive number when provided.");
  }

  const result = await runIntake(client, { sourceCode, search: input.search, limit: input.limit }, deps);
  const support = applicationSupportFor(result.sourceCode);

  return {
    sourceCode: result.sourceCode,
    displayName: result.displayName,
    attribution: result.attribution,
    search: result.search,
    received: result.received,
    skippedByAdapter: result.skippedByAdapter,
    ingested: result.ingested,
    trustStatusCounts: result.trustStatusCounts,
    applicationSupported: support.supported,
    applicationSupportNote: support.note,
    vacancies: result.outcomes.map((outcome) => ({
      vacancyId: outcome.vacancyId,
      title: outcome.title,
      companyName: outcome.companyName,
      outcome: outcome.outcome,
      ...(outcome.trustStatus !== undefined ? { trustStatus: outcome.trustStatus } : {}),
    })),
    dataNote:
      "These postings carry no country, salary or company domain: the source does not publish them in a form this pipeline can map without guessing. See server/intake/adapters/remotive.ts for each field's reasoning.",
    durationMs: result.durationMs,
  };
}
