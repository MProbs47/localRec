import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n';
import { useLocale } from '../i18n/useLocale';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Types the four demo lines character by character, then holds and loops (§3).
 * The first three lines are `--screen-text`, the fourth `--screen-dim` with a
 * block cursor. Under prefers-reduced-motion the whole block is shown at once
 * with no typing and no blink (§9).
 *
 * U8: moved out of `App.tsx` verbatim, together with `demoLines`.
 *
 * U3: `demoLines` is no longer a module-level export — it's resolved via
 * `t()` inside the component (render time), not at module scope: `main.tsx`
 * sets the locale only after its static imports (this module among them)
 * have already run, so a module-level `t()` call would freeze on whatever
 * locale was active before that. Nothing outside this file imported
 * `demoLines`, so this is an internal-only change. The typewriter still
 * slices these character-by-character, so a locale's translation is free to
 * run longer/shorter, but casing must not be normalized against the source.
 *
 * Code-review Befund 3: `demoLines` used to depend on `[]` (frozen at first
 * mount) — `useLocale()` below plus `[locale]` here re-derives it on every
 * real `setLocale()` call instead, so the always-visible language switcher
 * actually changes the most prominent text on the landing screen. Still a
 * `useMemo`, not a plain recompute: the effect below keys its interval reset
 * on THIS array's identity (`totalChars`, itself derived from `demoLines`),
 * so `demoLines` must stay referentially stable across renders that don't
 * change locale — recomputing it inline every render would restart the
 * typewriter on every unrelated re-render (e.g. the VU meter's rAF-driven
 * updates while recording).
 */
export function DemoLoop() {
  const reduced = usePrefersReducedMotion();
  const locale = useLocale();
  const [charCount, setCharCount] = useState(0);

  const demoLines = useMemo(
    () => [t('demo.line1'), t('demo.line2'), t('demo.line3'), t('demo.line4')],
    [locale],
  );

  const totalChars = useMemo(() => demoLines.reduce((n, line) => n + line.length + 1, 0), [demoLines]);

  useEffect(() => {
    if (reduced) {
      setCharCount(totalChars);
      return;
    }
    let count = 0;
    setCharCount(0);
    const id = window.setInterval(() => {
      count += 1;
      if (count > totalChars + 12) {
        count = 0; // hold ~ a beat past the end, then restart the loop
      }
      setCharCount(Math.min(count, totalChars));
    }, 55);
    return () => window.clearInterval(id);
  }, [reduced, totalChars]);

  // Map the flat char cursor back onto the four lines.
  let remaining = charCount;
  const shown = demoLines.map((line) => {
    const take = Math.max(0, Math.min(line.length, remaining));
    remaining -= line.length + 1; // +1 for the implicit newline between lines
    return line.slice(0, take);
  });
  const activeLine = shown.findIndex((text, i) => text.length < demoLines[i].length);
  const cursorLine = activeLine === -1 ? demoLines.length - 1 : activeLine;

  return (
    <p className="screen__lines" aria-hidden="true">
      {shown.map((text, i) => (
        <span key={i} className={i === demoLines.length - 1 ? 'screen__line screen__line--dim' : 'screen__line'}>
          {text}
          {i === cursorLine && !reduced && <span className="screen__cursor" />}
          {i < demoLines.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}
