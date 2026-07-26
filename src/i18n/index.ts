/**
 * The i18n core's public surface: `t()` plus re-exports of the locale
 * store (KTD1). Deliberately React-free and DOM-free — `useLocale()` lives
 * in its own file (`useLocale.ts`) purely because it needs to import
 * React; keeping that import out of this file matters because
 * `vitest.setup.ts` imports the locale pieces transitively and is
 * typechecked under `tsconfig.node.json` (no `lib: DOM`, see
 * `locale.ts`'s doc comment).
 */
import { de } from './strings.de';
import { en } from './strings.en';
import { it } from './strings.it';
import { fr } from './strings.fr';
import { es } from './strings.es';
import { getLocale, resolveLocale, setLocale, subscribeLocale } from './locale';
import type { Locale } from './locale';

export type { Locale };
export { getLocale, resolveLocale, setLocale, subscribeLocale };

/** Every valid lookup key, derived from the canonical `en` table (KTD2) — `de`/`it`/`fr`/`es` are checked against this by their own `Record<StringKey, string>` annotation. */
export type StringKey = keyof typeof en;

type StringTable = Record<StringKey, string>;

// All five real tables (KTD7 — no lazy-loading, no code-splitting: the
// whole bundle carries every locale). Each is `Record<StringKey, string>`,
// so a missing/extra key in any of them is a compile error (KTD2) — this
// registry itself has nothing left to enforce completeness.
const TABLES: Record<Locale, StringTable> = {
  de,
  en,
  it,
  fr,
  es,
};

/**
 * Replaces every `{name}` occurrence in `template` for which `params`
 * supplies a value. A placeholder with no matching param is left exactly
 * as-is — never throws. Split out from `t()` so the "replace every
 * occurrence" contract can be tested directly, independent of the string
 * tables.
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  let result = template;
  for (const [name, value] of Object.entries(params)) {
    result = result.split(`{${name}}`).join(String(value));
  }
  return result;
}

/** Looks `key` up in the active locale's table (KTD3) and interpolates `params`, if any. No ICU, no plurals, no nested keys — see KTD1. */
export function t(key: StringKey, params?: Record<string, string | number>): string {
  return interpolate(TABLES[getLocale()][key], params);
}
