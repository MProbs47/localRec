import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default environment stays 'node' — the vast majority of tests are
    // pure Storage/Pure-logic tests with no DOM need. `.tsx` component
    // tests opt into jsdom individually via a `// @vitest-environment
    // jsdom` docblock at the top of the file (Vitest 4's per-file
    // override), rather than flipping the whole suite to jsdom or reaching
    // for `environmentMatchGlobs`/workspace `projects` — both are more
    // machinery than one component test file needs (YAGNI).
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', '*.test.ts'],
    // U2 (KTD16, race-flake hardening): matches
    // `vitest.setup.ts`'s raised RTL `asyncUtilTimeout` (5000 ms) — a test
    // whose own per-test timeout (Vitest's 5000 ms default) is shorter than a
    // `waitFor` it calls would get cut off by Vitest itself before RTL ever
    // gets to time the `waitFor` out. 10000 ms leaves headroom for a slow
    // `waitFor` plus whatever else the test does around it.
    testTimeout: 10000,
  },
});
