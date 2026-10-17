import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { buildScheduledTasks } from "./schedulerTasks.js";

/**
 * THE PRODUCTION OFF-LIST, CHECKED AGAINST THE TASKS IT NAMES.
 *
 * schedulerTasks.parseDisabledTasks deliberately IGNORES an unknown name, so a typo or a renamed
 * task leaves the list silently inert — which is exactly what "discovery" did: it matched no task,
 * so the ingestion drains ran in production while the compose comment said they were off. A test
 * that reads the real compose file is the only thing that can catch that class of drift.
 */

const COMPOSE = readFileSync(resolve(process.cwd(), "docker-compose.prod.yml"), "utf8");

function disabledNames(): string[] {
  const match = COMPOSE.match(/SCHEDULER_DISABLED_TASKS:\s*"([^"]*)"/);

  if (!match) {
    throw new Error("SCHEDULER_DISABLED_TASKS was not found in docker-compose.prod.yml");
  }

  return match[1]!.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
}

const GOOGLE_ENV: Record<string, string | undefined> = {
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://app.test/callback",
  MAILBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
};

function allTaskNames(): string[] {
  return buildScheduledTasks({} as SupabaseClient, {} as Pick<OpenAI, "chat">, GOOGLE_ENV).map(
    (task) => task.name,
  );
}

describe("the production scheduler off-list", () => {
  it("names only tasks that exist, because an unmatched name is silently inert", () => {
    const names = new Set(allTaskNames());
    const disabled = disabledNames();

    expect(disabled.length).toBeGreaterThan(0);

    for (const name of disabled) {
      expect(names.has(name), name + " is listed as disabled but is not a task").toBe(true);
    }
  });

  it("leaves exactly the DB-only housekeeping switched on", () => {
    const disabled = new Set(disabledNames());
    const enabled = allTaskNames()
      .filter((name) => !disabled.has(name))
      .sort();

    // Pinned deliberately: adding a task forces a decision about whether production should run
    // it, rather than letting it default to on.
    expect(enabled).toEqual([
      "application-recovery",
      "follow-up-recovery",
      "oauth-state-sweep",
      "ranking-refresh",
    ]);
  });
});
