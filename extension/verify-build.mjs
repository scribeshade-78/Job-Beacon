#!/usr/bin/env node
/**
 * Cross-checks the packaged extension against the declarations it has to agree with.
 *
 * WHY THIS EXISTS: the first build emitted index.html while the manifest named
 * popup.html, and NOTHING failed - vite reported success, the files were all there, and
 * the only symptom would have been a popup that silently refuses to open when loaded
 * into Chrome. A missing referenced file is the one packaging error that produces no
 * error, so it is checked here rather than discovered by a user.
 *
 * IT HAS SINCE GROWN TWO DRIFT GUARDS. Both read SOURCE, not the package, because that is
 * where the drift starts:
 *
 *   1. SITE_PROFILES -> manifest matches. A site the registry knows but the manifest does
 *      not declare is UNREACHABLE: the content script never runs there, so the profile is
 *      dead code that reads as live. Not hypothetical - myworkdaysite.com was in
 *      SITE_PROFILES from the registry's first draft and absent from the manifest, and
 *      this check is what found it.
 *
 *   2. Design tokens. The overlay and the popup each carry a copy of the app's @theme
 *      variables, because a CSS file cannot import a TypeScript constant and the extension
 *      is a separate bundle. Every token either one copies must still match
 *      client/src/styles.css exactly, so "no new brand colours" is enforced rather than
 *      remembered.
 *
 * IT WAS DORMANT UNTIL NOW. Nothing referenced this script - not an npm script, not CI -
 * so it could not have caught anything. build.mjs runs it as the last step of the
 * extension build, which is what makes it a guard instead of a document.
 *
 * RUNNING IT BY HAND: it imports .ts sources, so it needs a TypeScript loader. build.mjs
 * spawns it with --import=tsx; on Node 22.18+ / Node 24 a plain
 * `node extension/verify-build.mjs` also works, because type stripping is on by default.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../dist/extension/", import.meta.url));
const manifestPath = new URL("../dist/extension/manifest.json", import.meta.url);

if (!existsSync(manifestPath)) {
  console.error("FAIL: dist/extension/manifest.json is missing.");
  process.exit(1);
}

let failed = 0;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const referenced = [];

if (manifest.background?.service_worker) referenced.push(["background.service_worker", manifest.background.service_worker]);
if (manifest.action?.default_popup) referenced.push(["action.default_popup", manifest.action.default_popup]);
for (const script of manifest.content_scripts ?? []) {
  for (const js of script.js ?? []) referenced.push(["content_scripts.js", js]);
  for (const css of script.css ?? []) referenced.push(["content_scripts.css", css]);
}

// Every file the manifest points at must exist. This is the check that exists because its
// absence produced a popup that silently refused to open.
for (const [where, file] of referenced) {
  const present = existsSync(new URL(file, new URL("file://" + out)));
  console.log((present ? "  ok      " : "  MISSING ") + where + " -> " + file);
  if (!present) failed++;
}

// Every permission must be one we can justify; an unexpected one is worth seeing.
console.log("\n  permissions:      " + JSON.stringify(manifest.permissions));
console.log("  host_permissions: " + JSON.stringify(manifest.host_permissions));
console.log("  manifest_version: " + manifest.manifest_version);

if (manifest.manifest_version !== 3) {
  console.error("FAIL: not Manifest V3.");
  failed++;
}

/* ------------------------------------------------------------------ *
 * 1. THE SITE REGISTRY MUST BE REACHABLE FROM THE MANIFEST
 * ------------------------------------------------------------------ */

let SITE_PROFILES;
let OVERLAY_TOKENS;
try {
  ({ SITE_PROFILES } = await import(new URL("./src/lib/sites.ts", import.meta.url)));
  ({ OVERLAY_TOKENS } = await import(new URL("./src/lib/tokens.ts", import.meta.url)));
} catch (error) {
  console.error("\nFAIL: could not load the extension's TypeScript registry.");
  console.error("      " + (error instanceof Error ? error.message : String(error)));
  console.error("      Re-run it with a TypeScript loader: node --import=tsx extension/verify-build.mjs");
  process.exit(1);
}

// The BUILT manifest is checked rather than public/manifest.json, because the built one is
// what ships; vite copies it across, so a divergence between the two is itself a bug.
const manifestHosts = [];
for (const script of manifest.content_scripts ?? []) {
  for (const match of script.matches ?? []) {
    const withoutScheme = String(match).replace(/^[a-z*]+:\/\//i, "");
    const host = withoutScheme.split("/")[0].toLowerCase();
    if (host !== "") manifestHosts.push(host);
  }
}

/**
 * Whether one manifest match pattern is enough to let detectSite's host through.
 *
 * A profile pattern P means "P and every subdomain of P" (see hostMatches in sites.ts), so a
 * manifest host of `boards.greenhouse.io` covers P = `greenhouse.io`, and
 * `*.myworkdayjobs.com` covers it too - Chrome's wildcard host includes the bare domain.
 */
function covers(profilePattern, manifestHost) {
  const base = manifestHost.startsWith("*.") ? manifestHost.slice(2) : manifestHost;
  return base === profilePattern || base.endsWith("." + profilePattern);
}

console.log("\n  content-script hosts: " + JSON.stringify(manifestHosts));
console.log("  site registry -> manifest coverage:");
for (const profile of SITE_PROFILES) {
  for (const pattern of profile.urlPatterns) {
    const reachable = manifestHosts.some((host) => covers(pattern, host));
    console.log((reachable ? "  ok          " : "  UNREACHABLE ") + profile.sourceCode + " -> " + pattern);
    if (!reachable) {
      console.error("              no manifest match covers this host, so content.js never runs there");
      console.error("              and the profile is dead. Either declare the host or drop the pattern.");
      failed++;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. THE EXTENSION'S COPIES OF THE APP'S DESIGN TOKENS MUST AGREE
 * ------------------------------------------------------------------ */

/** The custom properties declared in a file's first @theme block. */
function parseTheme(cssText) {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = withoutComments.indexOf("@theme");
  if (start === -1) return null;
  const open = withoutComments.indexOf("{", start);
  const close = withoutComments.indexOf("}", open);
  if (open === -1 || close === -1) return null;

  const map = new Map();
  for (const declaration of withoutComments.slice(open + 1, close).split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    // Whitespace is collapsed so a value wrapped across lines in one file and kept on one
    // line in the other still compares equal - only the value matters, not its formatting.
    map.set(name, declaration.slice(colon + 1).replace(/\s+/g, " ").trim());
  }
  return map;
}

const appTheme = parseTheme(readFileSync(fileURLToPath(new URL("../client/src/styles.css", import.meta.url)), "utf8"));
const popupTheme = parseTheme(readFileSync(fileURLToPath(new URL("./src/popup/index.css", import.meta.url)), "utf8"));

if (appTheme === null) {
  console.error("\nFAIL: client/src/styles.css has no @theme block, so there is nothing to check against.");
  failed++;
}

function checkTokens(label, theme) {
  if (theme === null) {
    console.error("\nFAIL: " + label + " declares no @theme block.");
    failed++;
    return;
  }
  console.log("\n  " + label + " tokens vs client/src/styles.css:");
  for (const [name, value] of theme) {
    const appValue = appTheme?.get(name);
    if (appValue === undefined) {
      console.error("  NOT-IN-THEME " + label + " " + name + " - the app defines no such token");
      failed++;
    } else if (appValue !== value) {
      console.error("  DRIFTED      " + label + " " + name + ": " + value + " != " + appValue);
      failed++;
    } else {
      console.log("  ok           " + label + " " + name);
    }
  }
}

checkTokens("overlay", new Map(Object.entries(OVERLAY_TOKENS)));
checkTokens("popup", popupTheme);

if (failed > 0) {
  console.error("\nFAIL: " + failed + " problem(s).");
  process.exit(1);
}
console.log("\nAll manifest references resolve, the registry is reachable, and the tokens agree.");
