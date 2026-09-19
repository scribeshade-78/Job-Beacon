/**
 * Re-export of the shared stage rule.
 *
 * The rule itself lives in shared/pipelineStages.ts because the MCP server
 * (server/mcp/) consumes it too, and tsconfig.server.json includes only
 * ["server", "shared"]. Everything this module used to export is still
 * exported here, so existing client imports and tests are unchanged.
 */
export * from "../../../shared/pipelineStages";
