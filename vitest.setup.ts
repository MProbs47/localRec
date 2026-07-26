// Global Vitest setup, run for every test file regardless of environment
// (node or jsdom). `@testing-library/jest-dom`'s matchers (`toBeVisible`,
// `toHaveAttribute`, ...) only extend `expect` — they don't touch `window`
// or `document` at import time, so requiring them here is harmless for the
// node-environment Storage/Pure tests (U1-U7) and only actually *used* by
// the jsdom-environment component tests (U8+).
import '@testing-library/jest-dom/vitest';

// NOTE: this file is typechecked under `tsconfig.node.json`, whose `lib` is
// deliberately `ES2022` only (no `DOM`) — it's shared by every test
// regardless of environment (node or jsdom), so it must not reference
// browser globals like `window`/`ResizeObserver` by name. jsdom-specific
// polyfills (e.g. for `@tanstack/react-virtual`'s use of
// `requestAnimationFrame`/`ResizeObserver`, absent from jsdom) therefore
// live next to the `.test.tsx` files that need them, where DOM types are
// available (`tsconfig.test.json`) — see `LiveTranscript.test.tsx`.

// U2 (KTD16, race-flake hardening): raise RTL's
// `waitFor` default of 1000 ms/50 ms-poll. Under full-suite load (up to 15
// parallel Vitest forks on 16 cores) a merely starved fork can overrun 1000 ms
// with nothing behaviourally wrong — this doesn't touch the guard-timing bug
// H2 diagnosed (that one never resolves late, it just never resolves), but it
// is still a real, independent safety margin against pure scheduler
// starvation. `vitest.config.ts`'s `testTimeout` is raised to match, so a
// slow `waitFor` isn't cut off one level up by Vitest's own per-test timeout.
// Imported from `@testing-library/dom` (not `@testing-library/react`): the
// latter's `pure.js` unconditionally `require()`s `react-dom`/`react-dom/client`
// at module load, which assume a DOM — unsafe to import here since this file
// also runs for the node-environment Storage/Pure tests (see comment above).
// `@testing-library/dom`'s `configure()` is plain, environment-agnostic JS
// config, safe either way — and, package types aside, `skipLibCheck` (this
// tsconfig) means the `Config` interface's own DOM-typed fields (e.g.
// `getElementError`'s `Element` parameter) are never resolved just by
// importing it, so the DOM-typing trap this comment used to warn about for a
// hypothetical `configure()` import does not actually bite here.
import { configure } from '@testing-library/dom';
configure({ asyncUtilTimeout: 5000 });

// U3 (KTD4): pin the UI locale to German for the whole suite. jsdom reports
// `navigator.language` as `en-US`; without this pin, the i18n extraction
// would make every test render English and break ~45 existing assertions
// across 11 test files that check German literals. Imported from
// `./src/i18n/locale` (not `./src/i18n`) — `locale.ts` is guaranteed
// DOM-free (see its own doc comment), which this file, typechecked without
// `lib: DOM`, depends on.
import { setLocale } from './src/i18n/locale';
setLocale('de');
