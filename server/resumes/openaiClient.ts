import OpenAI from "openai";

/**
 * Server/worker-only OpenAI-SDK client pointed at OpenRouter —
 * OPENROUTER_API_KEY is read directly from process.env, never a
 * VITE_-prefixed variable, and this module is never imported from
 * client/src. Same lazy-construction-with-injectable-default shape as
 * supabaseServiceRole.ts's createSupabaseServiceRoleClient: the key isn't
 * set in every environment, so eagerly constructing a client at module load
 * would break importing this file at all in those environments.
 */
export interface OpenAIConfig {
  apiKey: string;
  baseURL: string;
}

export function readOpenAIConfig(env: Record<string, string | undefined> = process.env): OpenAIConfig {
  const apiKey = env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OpenRouter configuration: OPENROUTER_API_KEY is required.");
  }

  return { apiKey, baseURL: "https://openrouter.ai/api/v1" };
}

export function createOpenAIClient(config: OpenAIConfig = readOpenAIConfig()): OpenAI {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
}
