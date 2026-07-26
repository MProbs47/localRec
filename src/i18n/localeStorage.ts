import { SUPPORTED, type Locale } from './locale';

/**
 * `localStorage` persistence for the UI-locale switcher (KTD17, U4 part b).
 *
 * Deliberately its OWN file, not folded into `locale.ts`: that module is
 * DOM-free on purpose (see its doc comment — `vitest.setup.ts` imports
 * `setLocale` from it and is typechecked under `tsconfig.node.json`, whose
 * `lib` is `ES2022` only, no `DOM`), and `localStorage` is a DOM global. This
 * file is imported only from the DOM side (`main.tsx`, `LocaleSwitch.tsx`),
 * both typechecked under `tsconfig.json`/`tsconfig.test.json` (which do carry
 * `lib: DOM`) — never from `locale.ts`, `index.ts` or `vitest.setup.ts`
 * itself. Keep it that way: importing this module from any of those three
 * would pull a `localStorage` reference into the node-only typecheck
 * program and break `npm run typecheck`.
 *
 * Both directions are defensive on purpose: `localStorage` can throw
 * (private browsing in some browsers, a revoked storage permission) and can
 * hold garbage (an old build's value, a hand-edited devtools entry, a locale
 * this build doesn't know). Neither case may stop the app from starting or
 * the switch from flipping — the browser-language default (R2) is always
 * the fallback, both at startup and if a write fails mid-session.
 */
const STORAGE_KEY = 'meeting-recorder-locale';

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value);
}

/**
 * The persisted locale choice, or `null` when there is none, the read
 * itself throws, or the stored value isn't one of the five supported
 * locales. Never throws.
 */
export function readStoredLocale(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persists `locale` for the next start. A write failure is swallowed — it
 * must not abort the locale switch that triggered it (the in-memory
 * `setLocale()` call already succeeded by the time this runs).
 */
export function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore — see file doc comment. The session still gets the new
    // locale; only next start's persistence is lost.
  }
}
