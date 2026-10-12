import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type UserConfig } from "vite";

/**
 * ONE CONFIG, THREE BUILDS, SELECTED BY EXT_ENTRY.
 *
 * WHY NOT ONE BUILD WITH THREE ENTRIES: a Manifest V3 content script cannot use ES
 * module imports, so it must be a single self-contained IIFE. An IIFE build cannot
 * share a chunk with another entry, so the content script and the service worker have
 * to be built separately from the popup - and from each other, since two IIFE inputs
 * in one Rollup build is not a thing that works.
 *
 * Both script bundles are import-free by construction: the only imports in content.ts
 * and background.ts are `import type`, which is erased. That is what lets them use the
 * IIFE format without a bundler shim.
 */
const outDir = fileURLToPath(new URL("../dist/extension", import.meta.url));

// THE REPO ROOT, NOT extension/. Vite resolves VITE_* from envDir, and the Supabase
// publishable URL/key live in the root .env alongside everything else. Left at the
// default, the extension would build with those undefined and fail at runtime with no
// obvious cause - the same failure mode the web app's own config documents.
const envDir = fileURLToPath(new URL("..", import.meta.url));
const entry = process.env.EXT_ENTRY ?? "popup";

// ANNOTATED AS UserConfig. Without it TypeScript infers each branch's shape
// independently and WIDENS the literals - `publicDir: false` becomes boolean and
// `formats: ["iife"]` becomes string[] - neither of which vite's types accept. One
// annotation is better than `as const` sprinkled on every field until it compiles.
export default defineConfig((): UserConfig => {
  if (entry === "popup") {
    return {
      root: fileURLToPath(new URL("./src/popup", import.meta.url)),
      envDir,
      // Copies public/manifest.json into the output, which is how the manifest ships
      // without a copy step of its own.
      publicDir: fileURLToPath(new URL("./public", import.meta.url)),
      plugins: [react(), tailwindcss()],
      build: {
        outDir,
        emptyOutDir: true,
        rollupOptions: {
          // THE SOURCE FILE NAME IS THE OUTPUT NAME. Vite derives an HTML entry's
          // emitted path from its location relative to root, NOT from the input key -
          // so this file must be called popup.html for the manifest's
          // action.default_popup to resolve. Naming the key "popup" while the file was
          // index.html shipped an extension whose popup silently refused to open, and
          // nothing in the build reported a problem.
          input: { popup: fileURLToPath(new URL("./src/popup/popup.html", import.meta.url)) },
          output: { entryFileNames: "popup.js", assetFileNames: "popup.[ext]" },
        },
      },
    };
  }

  const file = entry === "content" ? "./src/content.ts" : "./src/background.ts";

  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    envDir,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      lib: {
        entry: fileURLToPath(new URL(file, import.meta.url)),
        formats: ["iife"],
        name: entry === "content" ? "JobBeaconContent" : "JobBeaconBackground",
        fileName: () => entry + ".js",
      },
    },
  };
});
