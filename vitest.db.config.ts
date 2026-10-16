import { configDefaults, defineConfig } from "vitest/config";

/**
 * The DB-BACKED integration suite, kept separate from BOTH other suites.
 *
 * WHY IT IS NOT IN npm test. It opens a real PostgREST connection to the local Supabase stack and
 * writes rows. The default suite must run anywhere, with no database and no Docker, so these files
 * are excluded from vitest.config.ts by the same *.integration.test.ts rule that keeps the
 * vendor-network suite out of the build.
 *
 * WHY IT IS NOT IN npm run test:integration EITHER. That suite talks to third-party vendors over
 * the network; this one needs a local Postgres. Different prerequisite, different failure mode, so
 * a vendor having a bad afternoon and a stopped Docker stack are never confused for one another.
 *
 *   npm run test:db
 */
export default defineConfig({
  test: {
    include: ["**/*.db.integration.test.ts"],
    exclude: [...configDefaults.exclude, "**/dist/**", "**/.kilo/**"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // These tests write to shared tables. Serial files stop one test's cleanup from racing
    // another's rows; correctness of the proof matters more here than wall-clock time.
    fileParallelism: false,
  },
});
