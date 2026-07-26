/**
 * React binding for the locale store (KTD3, Owner-revidiert 2026-07-25):
 * once the language switcher (KTD17, U4) lets the user change the locale at
 * runtime, components need to re-render on that change — plain module
 * reads of `getLocale()` wouldn't. Kept in its own file (not `index.ts`)
 * purely because it imports React; `index.ts`/`locale.ts` must stay
 * React-free/DOM-free (see their doc comments) so `vitest.setup.ts`'s
 * node-only typecheck of the i18n core keeps passing.
 *
 * Called from `App.tsx` (subscribes the whole tree to re-render on a locale
 * change) and `LocaleSwitch.tsx` (reads the active locale for its flag/code
 * display).
 */
import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale } from './locale';
import type { Locale } from './locale';

/** Reactive read of the active UI locale; re-renders the calling component on every real `setLocale` change. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
