#!/usr/bin/env node
/**
 * Cross-checks the built extension against its own manifest.
 *
 * WHY THIS EXISTS: the first build emitted index.html while the manifest named
 * popup.html, and NOTHING failed - vite reported success, the files were all there, and
 * the only symptom would have been a popup that silently refuses to open when loaded
 * into Chrome. A missing referenced file is the one packaging error that produces no
 * error, so it is checked here rather than discovered by a user.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../dist/extension/", import.meta.url));
const manifestPath = new URL("../dist/extension/manifest.json", import.meta.url);

if (!existsSync(manifestPath)) {
  console.error("FAIL: dist/extension/manifest.json is missing.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const referenced = [];

if (manifest.background?.service_worker) referenced.push(["background.service_worker", manifest.background.service_worker]);
if (manifest.action?.default_popup) referenced.push(["action.default_popup", manifest.action.default_popup]);
for (const script of manifest.content_scripts ?? []) {
  for (const js of script.js ?? []) referenced.push(["content_scripts.js", js]);
  for (const css of script.css ?? []) referenced.push(["content_scripts.css", css]);
}

let failed = 0;
for (const [where, file] of referenced) {
  const present = existsSync(new URL(file, new URL("file://" + out)));
  console.log((present ? "  ok      " : "  MISSING ") + where + " -> " + file);
  if (!present) failed++;
}

// Every permission must be one we can justify; an unexpected one is worth seeing.
console.log("\n  permissions:      " + JSON.stringify(manifest.permissions));
console.log("  host_permissions: " + JSON.stringify(manifest.host_permissions));
console.log("  manifest_version: " + manifest.manifest_version);

if (manifest.manifest_version !== 3) { console.error("FAIL: not Manifest V3."); failed++; }
if (failed > 0) { console.error("\nFAIL: " + failed + " problem(s)."); process.exit(1); }
console.log("\nAll manifest references resolve.");
