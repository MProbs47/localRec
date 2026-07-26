// @vitest-environment jsdom
/**
 * Code-review Befund 3: `demoLines` used to be built in a `useMemo(…, [])` —
 * empty dependencies, so the text froze on whatever locale was active at
 * first mount. The language switcher (`LocaleSwitch`) is always visible next
 * to these lines, and they're the most prominent text on the landing screen,
 * so a language switch that leaves them stuck in the old language is the
 * most visible possible miss. Fixed by depending on `useLocale()`'s value.
 *
 * `stubMatchMedia(true)` (reduced-motion ON, same helper shape as
 * `App.test.tsx`'s) makes the typewriter skip straight to the full text
 * (`charCount = totalChars`) with no `setInterval` ticking — the simplest way
 * to assert on the rendered text without fighting real timers.
 */
import { cleanup, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DemoLoop } from './DemoLoop';
import { setLocale } from '../i18n/locale';

function stubMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

beforeEach(() => {
  stubMatchMedia(true); // reduced motion on — full text renders immediately, no timer
});

afterEach(() => {
  cleanup();
  setLocale('de'); // restore the suite-wide German-locale pin — don't leak the locale into other test files
});

describe('DemoLoop follows a locale switch', () => {
  it('re-renders the demo lines in the newly active locale', () => {
    const { container } = render(<DemoLoop />);
    expect(container.textContent).toContain('KEINE DATEN VERLASSEN DEIN GERÄT.');

    act(() => setLocale('fr'));

    expect(container.textContent).toContain('AUCUNE DONNÉE NE QUITTE JAMAIS TON APPAREIL.');
    expect(container.textContent).not.toContain('KEINE DATEN VERLASSEN DEIN GERÄT.');
  });
});
