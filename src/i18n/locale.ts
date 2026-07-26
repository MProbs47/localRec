/**
 * Locale resolution plus a tiny module-level store for the active UI
 * locale (KTD1/KTD3).
 *
 * DOM-FREE ON PURPOSE: `vitest.setup.ts` imports `setLocale` from this file
 * to pin the whole test suite's locale to German by default, and that file is
 * typechecked under `tsconfig.node.json`, whose `lib` is deliberately
 * `ES2022` only — no
 * `DOM`, because it's shared by every test regardless of environment (node
 * or jsdom). A reference to `navigator`/`window`/`localStorage`/`document`
 * anywhere in this module would break `npm run typecheck`. Resolving the
 * *actual* browser language (`navigator.languages`) therefore happens in
 * the caller (`main.tsx`), not here — this module only ever takes a plain
 * array of language tags handed to it and never reaches for a global
 * itself.
 */

export const SUPPORTED = ['de', 'en', 'it', 'fr', 'es'] as const;
export type Locale = (typeof SUPPORTED)[number];

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED);

/**
 * Picks the first entry in `langs` whose primary subtag (`de-CH` → `de`,
 * `es-419` → `es`) is supported; falls back to `'en'` if none match, or if
 * `langs` is empty/absent. Never throws — a malformed/empty tag is simply
 * skipped, not fatal.
 */
export function resolveLocale(langs: readonly string[] | null | undefined): Locale {
  for (const tag of langs ?? []) {
    const primary = tag.split('-')[0]?.toLowerCase();
    if (primary && SUPPORTED_SET.has(primary)) return primary as Locale;
  }
  return 'en';
}

type Listener = () => void;

// Module-level singleton store — same subscribe/getSnapshot idiom as
// `TranscriptStore` (`src/ui/transcriptStore.ts`) and `Engine`
// (`src/engine/engine.ts`), just without a class: there's only ever one
// active locale for the whole app, so a class instance would add ceremony
// with no second caller to justify it (YAGNI).
let currentLocale: Locale = 'en';
const listeners = new Set<Listener>();

/** The currently active UI locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/** Sets the active UI locale; notifies subscribers only when it's an actual change (no-op on setting the same value). */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore`'s `subscribe` shape — registers `listener` to be called after every real `setLocale` change, returns an unsubscribe function. */
export function subscribeLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
