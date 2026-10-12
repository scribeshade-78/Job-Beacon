import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .kilo/worktrees/* are linked git worktrees — full second copies of this
    // repository. Without this exclude vitest collects the duplicate test files
    // too, which doubled the suite and reliably blew the forks-pool startup
    // timeout on the copies: `npm test` exited 1 with "Test Files 259 passed,
    // Tests 3479 passed, Errors 7" and no actual test failure. A gate that
    // reports failure when nothing failed is worse than no gate, so the
    // duplicate tree is excluded rather than tolerated.
    exclude: [...configDefaults.exclude, "**/dist/**", "**/.kilo/**"],
    environment: "jsdom",
    // Registers @testing-library/jest-dom's matchers on Vitest's expect. Without
    // it toBeEnabled() and friends are undefined rather than failing to match —
    // see vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
  },
});
