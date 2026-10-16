import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * EVERY model call must bound its output.
 *
 * WHY A SOURCE SCAN AND NOT A UNIT TEST PER CALL SITE. Three separate call sites were missing
 * max_tokens at different times (resume and cover-letter generation once, then the fit call,
 * then five more), each found only when the provider refused a live request with "402 ...
 * requested up to 131072 tokens". A per-call test only covers the calls someone remembered to
 * write it for; this covers the ones nobody has written yet, including the next one added.
 *
 * The heuristic is deliberately loose — max_tokens must appear within the argument list that
 * follows the call — because being slightly over-inclusive costs a re-read, while being
 * under-inclusive costs a production outage.
 */

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

// EXPLICIT TIMEOUT, because this scan is I/O over the whole server tree and the 5s default is
// too tight under full-suite parallel load - it passed in isolation and timed out at 15.7s in the
// full run. The work is real and bounded, so it gets a budget rather than a shortcut.
describe("LLM call sites", { timeout: 60_000 }, () => {
  it("bounds max_tokens on every chat.completions.create call", () => {
    const offenders: string[] = [];

    for (const path of sourceFiles("server")) {
      const source = readFileSync(path, "utf8");
      const needle = "completions.create(";
      let at = source.indexOf(needle);

      while (at !== -1) {
        // The whole argument object follows the call; 900 characters comfortably spans it.
        const call = source.slice(at, at + 900);
        if (!call.includes("max_tokens")) {
          offenders.push(path + " (offset " + at + ")");
        }
        at = source.indexOf(needle, at + needle.length);
      }
    }

    expect(offenders, "uncapped model calls: " + offenders.join(", ")).toEqual([]);
  });
});
