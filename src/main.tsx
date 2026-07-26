import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (U12 / spec §2) — @fontsource ships local woff2 + @font-face,
// bundled and served same-origin so the app starts offline and satisfies the
// U1 CSP (default-src 'self'); never Google Fonts. Only the used weights are
// pulled in (Inter 600/800 titles, JetBrains Mono 400/500 mono).
//
// Deliberately the per-SUBSET entry points, not the aggregate `600.css` etc.:
// the aggregates also declare cyrillic/cyrillic-ext/greek/greek-ext/vietnamese
// @font-faces, which the five shipped locales (de/en/fr/it/es) can never
// render. Two costs followed from that. Dead weight (16 files, ~128 KB) — and,
// worse, the smallest of those subset files fell under Vite's 4 KB
// `assetsInlineLimit` and were inlined as `data:` URIs, which `default-src
// 'self'` blocks (no `font-src` is set, by design) — six CSP violations in the
// console of an app whose whole pitch is a clean one. Fixing it here rather
// than by widening the CSP to `font-src … data:` keeps the policy strict.
// latin + latin-ext together cover all five locales (umlauts, accents, ß, œ).
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/inter/latin-ext-800.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-ext-500.css';
import App from './App';
import { getLocale, resolveLocale, setLocale, subscribeLocale } from './i18n';
import { readStoredLocale } from './i18n/localeStorage';

// U3/KTD15 + U4/KTD17: resolve the UI locale once at startup — a stored
// choice from an earlier `LocaleSwitch` click wins first (R2's override),
// falling back to the browser's language list only when nothing was ever
// saved — and set `<html lang>` from it (screen readers, hyphenation). The
// manifest stays `de` — five manifest variants aren't worth it for install
// metadata alone.
const locale = readStoredLocale() ?? resolveLocale(navigator.languages);
setLocale(locale);
document.documentElement.lang = locale;

// U4/KTD17: keep `<html lang>` truthful across a RUNTIME switch too, not
// just at startup — without this, clicking `LocaleSwitch` would flip every
// piece of rendered text but leave `<html lang>` pointing at the old locale,
// which is exactly the "lies after the first click" bug KTD15 warns about.
// A `subscribeLocale` listener here (rather than, say, an effect inside
// `App`) keeps this DOM bookkeeping next to the OTHER place that already
// touches `document.documentElement.lang` (the startup line just above),
// instead of splitting one concern across two files.
subscribeLocale(() => {
  document.documentElement.lang = getLocale();
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('#root element missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
