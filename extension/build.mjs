#!/usr/bin/env node
/**
 * The extension build, driven from Node rather than from an npm script chain.
 *
 * WHY NOT AN INLINE ENV VAR: \`EXT_ENTRY=popup vite build\` is POSIX shell syntax and
 * silently does nothing useful in PowerShell or cmd, where it sets a PowerShell variable
 * instead of an environment variable. The usual fix is a \`cross-env\` dependency; a
 * 30-line script that spawns vite three times is cheaper than a dependency every
 * contributor installs forever, and it behaves identically on both platforms.
 *
 * --mode extension LOADS .env.extension, NOT .env. The repo .env points at the local
 * Supabase for development, so without this the extension is built against 127.0.0.1:54321
 * and every sign-in fails with 'Invalid login credentials' for a user whose account exists
 * perfectly well in production. Mode-specific files take precedence over .env, so this
 * fixes the extension without changing the client build - which deploy.sh asserts against
 * .env and would refuse if the two disagreed.
 *
 * The three builds are SEQUENTIAL and ORDERED: the popup runs first with
 * \`emptyOutDir: true\`, so it clears the output before the two script bundles add
 * themselves to it with \`emptyOutDir: false\`. Reordering these silently drops files.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entries = ["popup", "content", "background"];
const config = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

for (const entry of entries) {
  process.stdout.write("\n=== building " + entry + " ===\n");

  const result = spawnSync(process.execPath, [vite, "build", "--config", config, "--mode", "extension"], {
    stdio: "inherit",
    env: { ...process.env, EXT_ENTRY: entry },
  });

  if (result.status !== 0) {
    process.stderr.write("\nBuild failed for " + entry + ".\n");
    process.exit(result.status ?? 1);
  }
}


/**
 * PRODUCTION POINTING IS ASSERTED, NOT ASSUMED.
 *
 * A build with no VITE_* env vars SUCCEEDS. It produces a bundle that points at nothing, or
 * - worse - at whatever the developer's .env happens to hold, which in this repo is a LOCAL
 * Supabase on http://127.0.0.1:54321. The extension then signs in against a database that
 * does not contain the candidate's account and reports "Invalid login credentials" for
 * someone who is signed in to the web app perfectly well. That is exactly what shipped once
 * already, and it cost an afternoon.
 *
 * The assertion is POSITIVE: the built bundle must contain the host named in
 * .env.extension. An earlier version scanned the output for loopback addresses instead, and
 * refused a perfectly good build - the bundled supabase-js library contains
 * "http://localhost:9999" in its own code, so a loopback scan cannot tell a misconfigured
 * build from a correct one. Asserting the expected host PRESENT catches the same failure
 * with no false positives, because a bundle built against local Supabase cannot contain the
 * production host.
 *
 * The project host is read from .env.extension rather than hardcoded, so the check keeps
 * working if the project ever moves and cannot silently drift from the file it validates.
 */
const envFile = fileURLToPath(new URL("../.env.extension", import.meta.url));
let expectedHost = null;
try {
  const raw = readFileSync(envFile, "utf8");
  const match = raw.match(/^VITE_SUPABASE_URL=(.+)$/m);
  if (match) expectedHost = new URL(match[1].trim()).host;
} catch {
  // Handled below, with a message that says what to do rather than what went wrong.
}

const builtBackground = readFileSync(fileURLToPath(new URL("../dist/extension/background.js", import.meta.url)), "utf8");

if (expectedHost === null) {
  process.stderr.write(
    "\nRefusing to ship: .env.extension is missing or has no VITE_SUPABASE_URL.\n" +
      "Create it with the PRODUCTION publishable URL and key - both are public, and are\n" +
      "already served to every visitor in the production web bundle.\n",
  );
  process.exit(1);
}

if (!builtBackground.includes(expectedHost)) {
  process.stderr.write(
    "\nRefusing to ship: the built extension does not contain " + expectedHost + ".\n" +
      "It was built without that value inlined, so it would sign in against nothing.\n",
  );
  process.exit(1);
}

process.stdout.write("Production pointing asserted: " + expectedHost + "\n");

process.stdout.write("\nExtension built into dist/extension\n");
