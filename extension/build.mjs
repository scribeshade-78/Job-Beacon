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
 * The three builds are SEQUENTIAL and ORDERED: the popup runs first with
 * \`emptyOutDir: true\`, so it clears the output before the two script bundles add
 * themselves to it with \`emptyOutDir: false\`. Reordering these silently drops files.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entries = ["popup", "content", "background"];
const config = fileURLToPath(new URL("./vite.config.ts", import.meta.url));
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

for (const entry of entries) {
  process.stdout.write("\n=== building " + entry + " ===\n");

  const result = spawnSync(process.execPath, [vite, "build", "--config", config], {
    stdio: "inherit",
    env: { ...process.env, EXT_ENTRY: entry },
  });

  if (result.status !== 0) {
    process.stderr.write("\nBuild failed for " + entry + ".\n");
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\nExtension built into dist/extension\n");
