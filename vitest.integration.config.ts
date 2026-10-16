import { configDefaults, defineConfig } from "vitest/config";

/**
 * The OPT-IN integration suite, kept deliberately separate from `npm test`.
 *
 * WHY SEPARATE. These tests call third parties over the network. In the default suite
 * a vendor having a bad afternoon would fail the build for everyone, and a gate that
 * fails when nothing is wrong gets ignored - which is worse than having no gate. This
 * config is run deliberately, by someone who wants to know whether a vendor has
 * drifted.
 *
 * NODE ENVIRONMENT, not jsdom: nothing here renders, and jsdom only adds startup cost.
 * The timeout is raised because a real network round trip is not a unit test.
 */
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    // *.db.integration.test.ts also matches *.integration.test.ts, but it needs a local Postgres
    // rather than a network. It belongs to vitest.db.config.ts (npm run test:db); excluding it here
    // keeps this suite's contract exactly "a vendor is reachable".
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "**/.kilo/**",
      "**/*.db.integration.test.ts",
    ],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
