import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./client", import.meta.url)),
  // Vite defaults envDir to the resolved `root` (client/) when unset, so
  // .env files at the repository root (where they actually live, alongside
  // package.json and server/) were never found. Verified directly via
  // vite's own loadEnv(): without this, VITE_SUPABASE_* resolve to absent.
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5000",
    },
  },
});

