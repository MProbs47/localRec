// @vitest-environment jsdom
/**
 * Was diese Ansicht garantieren muss, ist weniger, als man denkt — aber genau
 * das eine ist verbindlich: sie hat KEINE Interaktion (Owner-Entscheid
 * 2026-07-26). Kein Knopf, kein Menü, kein Weg in die Aufnahme. Genau dafür
 * gibt es hier einen Test, denn diese Eigenschaft geht beim nächsten „nur noch
 * schnell ein Link" still verloren, und ein `<button>` auf dieser Seite
 * bedeutet, dass ein Telefon in `App` gerät.
 *
 * Ausserdem geprüft: die Kopie ist wirklich die WIEDERVERWENDETE (`info.what*`,
 * `header.subtitle*`), nicht eine zweite Fassung derselben Sätze, die
 * auseinanderlaufen kann.
 *
 * NICHT geprüft: Geometrie und Lesbarkeit — die leben in `mobile.css`, und
 * jsdom rechnet kein Layout (dieselbe Grenze, die `RecordButton.test.tsx`
 * nennt). Dieser Teil wird am Gerät abgenommen.
 *
 * `stubMatchMedia(true)` (reduzierte Bewegung an) wie in `DemoLoop.test.tsx`:
 * die Tippschleife rendert damit ihren vollen Text ohne Timer.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MobileView } from './MobileView';
import { de } from '../i18n/strings.de';
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
  stubMatchMedia(true); // reduzierte Bewegung an — voller Demotext, kein Timer
  setLocale('de');
});

afterEach(cleanup);

describe('MobileView', () => {
  it('bietet keine einzige Interaktion an — kein Knopf, kein Link, kein Eingabefeld', () => {
    const { container } = render(<MobileView />);

    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    // Auch nichts, was über ein Attribut fokussierbar/klickbar gemacht wurde.
    expect(container.querySelectorAll('[tabindex], [role="button"]')).toHaveLength(0);
  });

  it('nennt, wo das Werkzeug läuft', () => {
    render(<MobileView />);

    expect(screen.getByText(de['mobile.runsOnDesktopLabel'])).toBeInTheDocument();
    expect(screen.getByText(de['mobile.runsOnDesktopBody'])).toBeInTheDocument();
  });

  it('trägt die Marke und die zwei Untertitelzeilen des Geräts, wörtlich', () => {
    const { container } = render(<MobileView />);

    // Die Wortmarke ist über zwei Elemente gesetzt ("local" + rotes "Rec"),
    // darum am Textinhalt der Überschrift geprüft, nicht per getByText.
    expect(container.querySelector('h1')?.textContent).toBe(
      `${de['header.brandLocal']}${de['header.brandRec']}`,
    );
    expect(screen.getByText(de['header.subtitleTagline'])).toBeInTheDocument();
    expect(screen.getByText(de['header.subtitleFlightMode'])).toBeInTheDocument();
  });

  it('zeigt als drei Fakten die bestehenden Info-Sätze, nicht neu getextete', () => {
    render(<MobileView />);

    for (const key of ['info.what1', 'info.what3', 'info.what4'] as const) {
      expect(screen.getByText(de[key])).toBeInTheDocument();
    }
  });
});
