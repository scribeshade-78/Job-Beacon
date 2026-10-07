/**
 * Vitest global setup — currently one import.
 *
 * WHY THIS FILE EXISTS. @testing-library/jest-dom has been a devDependency since
 * the UI work, but nothing ever imported it: vitest.config.ts declared no
 * setupFiles, so its matchers (toBeEnabled, toBeInTheDocument, toHaveTextContent,
 * ...) were simply not on `expect`. Nothing caught that, because no existing test
 * used one — every assertion in this repository is a plain Vitest expect
 * (toBeTruthy, toBeNull, toEqual). The first test that reached for toBeEnabled()
 * therefore failed with a truncated DOM dump and a stale-looking element
 * reference, which reads as a component bug rather than a missing matcher.
 *
 * THE "/vitest" ENTRY POINT, NOT THE PACKAGE ROOT. The root export extends Jest's
 * global `expect`, which does not exist under Vitest, so importing it here would
 * silently register nothing. The /vitest build extends Vitest's own expect and
 * ships the matching type augmentation (types/vitest.d.ts) — which is also why
 * tsconfig.json's `include` has to cover THIS file: its `types` array is pinned
 * to ["vite/client"], so the augmentation reaches the test files only because this
 * file is part of the same TypeScript program.
 *
 * IMPORT-ONLY IN SPIRIT. This runs before every test file in the suite, including
 * the server-side ones, so it must not assume a browser beyond the jsdom
 * environment vitest.config.ts already sets for everything.
 */
import "@testing-library/jest-dom/vitest";
