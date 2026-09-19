import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSupabaseServiceRoleClient } from "../supabaseServiceRole.js";
import { MAX_BULK_APPLY_VACANCIES } from "../applications/bulkApply.js";
import {
  discoverLiveJobs,
  getCandidatePipeline,
  getOpportunityDetails,
  queueApplications,
} from "./tools.js";

/**
 * Mini-Phase 9 — the JobBeacon MCP server (`npm run mcp`).
 *
 * Speaks the Model Context Protocol over stdio so a terminal agent can attach
 * to it directly. Uses the official @modelcontextprotocol/sdk rather than a
 * hand-rolled JSON-RPC loop: the transport and the initialize/capability
 * handshake are exactly the parts where "spec conformant" is worth inheriting
 * rather than reimplementing.
 *
 * TRANSPORT: stdio only. There is no HTTP or SSE listener here, and no port is
 * opened. Note this differs from the read-only placeholder URL shown in the
 * Integrations Hub on the Profile page (https://api.jobbeacon.local/mcp) —
 * that string is inert placeholder copy. A stdio server is attached by a
 * client process, not reached at a URL, so the two are not the same thing and
 * the UI copy should not be read as promising an address.
 *
 * STDOUT IS THE PROTOCOL CHANNEL. Anything written to stdout that is not a
 * JSON-RPC frame corrupts the session, so this file logs exclusively to
 * stderr — including the startup line and every tool failure. console.log is
 * never used here, deliberately.
 *
 * TWO READ TOOLS AND TWO WRITE TOOLS, AND BOTH WRITES ARE DELIBERATELY BOUNDED.
 *
 * queue_applications enqueues through the same gate-respecting path the HTTP
 * route and the worker use, so an agent can queue work but cannot bypass an
 * eligibility gate, submit anything, or drain the queue.
 *
 * discover_live_jobs (Task W) fetches real postings from a live public source
 * and ingests them as vacancies — the door that replaces hand-seeded fixture
 * rows. It honours the source's own switch: a source whose kill_switch is on or
 * whose discovery_allowed is false is refused exactly as the scheduled
 * ingestion worker refuses it.
 *
 * See tools.ts for the exact boundaries and why they sit there.
 */

const SERVER_NAME = "jobbeacon";
const SERVER_VERSION = "0.1.0";

/** Every tool result is JSON text — the most portable shape for any client. */
function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * A failed tool is reported in-band with isError, not by throwing: an
 * exception escaping the handler becomes a transport-level error the client
 * cannot attribute to a tool, whereas this gives the agent the actual reason
 * (an ambiguous candidate, a missing vacancy) in the same shape as a success.
 */
function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mcp] tool call failed: ${message}`);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

async function main() {
  const client = createSupabaseServiceRoleClient();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "get_candidate_pipeline",
    {
      title: "Get candidate pipeline",
      description:
        "Aggregated counts and per-stage application details across the six pipeline stages (All, In Progress, Applied, Interview, Offer, Rejection). Stages are mutually exclusive, so the five categorized counts sum to All. Omitting candidate_id works when exactly one candidate exists; with more than one the call fails rather than guessing.",
      inputSchema: {
        candidate_id: z
          .string()
          .optional()
          .describe("Candidate UUID. Omit when exactly one candidate exists."),
      },
    },
    async ({ candidate_id }) => {
      try {
        return textResult(await getCandidatePipeline(client, { candidateId: candidate_id }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_opportunity_details",
    {
      title: "Get opportunity details",
      description:
        "Returns the complete vacancies row for one vacancy_id, its company row, the candidate's application plan with every blocking eligibility gate and its reason code, and that plan's attempts. Read-only.",
      inputSchema: {
        vacancy_id: z.string().describe("Vacancy UUID."),
        candidate_id: z
          .string()
          .optional()
          .describe("Candidate UUID. Omit when exactly one candidate exists."),
      },
    },
    async ({ vacancy_id, candidate_id }) => {
      try {
        return textResult(await getOpportunityDetails(client, { vacancyId: vacancy_id, candidateId: candidate_id }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "queue_applications",
    {
      title: "Queue applications",
      description:
        "Enqueues an application for each vacancy_id: creates the application plan and, when the eligibility gates pass, a pending application attempt for the worker to drain. Returns the same outcome the HTTP bulk-apply route does — requested, queued, blocked, errors, and the per-vacancy blocking gates and reason codes. Every safety gate still applies, so a vacancy can legitimately come back blocked (for example NO_ADAPTER_REGISTERED_FOR_SOURCE or DAILY_APPLICATION_LIMIT_EXCEEDED) and queued may be 0. This enqueues only; it does not submit anything.",
      inputSchema: {
        vacancy_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_BULK_APPLY_VACANCIES)
          .describe(`Vacancy UUIDs to enqueue. At most ${MAX_BULK_APPLY_VACANCIES} per call.`),
        candidate_id: z
          .string()
          .optional()
          .describe("Candidate UUID. Omit when exactly one candidate exists."),
      },
    },
    async ({ vacancy_ids, candidate_id }) => {
      try {
        return textResult(
          await queueApplications(client, { vacancyIds: vacancy_ids, candidateId: candidate_id }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "discover_live_jobs",
    {
      title: "Discover live jobs",
      description:
        "Fetches currently-open job postings from a live public source and ingests them as vacancies, then returns the vacancy ids it wrote so they can be inspected or queued. This is how the pipeline is fed real data instead of hand-seeded fixtures. The source's own policy still applies: a source whose kill_switch is on, or whose discovery_allowed is false, is refused. Note that discovery and application are separate capabilities — for a source with no registered submission adapter the result reports applicationSupported: false, and queue_applications will reject these vacancies with NO_ADAPTER_REGISTERED_FOR_SOURCE.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Free-text search passed to the source, e.g. \"data engineer\". Omit to browse whatever the source returns by default."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum postings to ingest. Defaults to 20, capped at 100."),
        source_code: z
          .string()
          .optional()
          .describe("Intake source to query. Omit when exactly one source is registered."),
      },
    },
    async ({ search, limit, source_code }) => {
      try {
        return textResult(
          await discoverLiveJobs(client, { sourceCode: source_code, search, limit }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  await server.connect(new StdioServerTransport());

  // stderr, never stdout: stdout carries JSON-RPC frames only.
  console.error(`[mcp] ${SERVER_NAME} ${SERVER_VERSION} attached on stdio`);
}

main().catch((error) => {
  console.error("[mcp] fatal error", error);
  process.exit(1);
});
