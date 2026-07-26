import { t } from '../i18n';
import { DemoLoop } from './DemoLoop';
// Tokens (§2), Reset und die Klassen der Tippschleife (`.screen__lines`,
// `.screen__cursor` samt Blink-Keyframe und der
// `prefers-reduced-motion`-Regel darüber) — dieselbe Quelle wie das Gerät,
// damit es EIN Designsystem bleibt und nicht zwei.
import './theme.css';
import './mobile.css';

/**
 * Die Handy-Ansicht: was localRec ist, für jemanden, der den LinkedIn-Post auf
 * dem Telefon öffnet.
 *
 * Warum eine eigene Ansicht und nicht ein Media-Query am Gerät (Owner-Entscheid
 * 2026-07-26, mit Foto vom Gerät): die Desktop-Komposition ist abgenommen und
 * soll unangetastet bleiben. Sie ist auch von der Bauweise her nicht
 * schrumpfbar — Kopf, Bühne und Fuss sind absolut in die drei Viewport-Ecken
 * verankert, damit das Display beim ready→recording-Morph wachsen kann, und
 * auf 390px stapeln diese Ecken übereinander. Eine zweite Ansicht ist hier
 * die kleinere Lösung als ein Umbau der ersten.
 *
 * KEINE Interaktion (Owner-Entscheid, dieselbe Runde): kein Knopf, kein Menü,
 * kein Sprachwähler, kein Weg in die App. Diese Datei enthält deshalb keinen
 * State, keinen Handler und kein `<button>` — was hier steht, wird gelesen.
 * Zwei Folgen, beide gewollt:
 *   - Die Sprache kommt allein aus `navigator.languages` (`main.tsx` setzt sie
 *     vor dem ersten Render), darum braucht diese Ansicht kein `useLocale()`:
 *     zur Laufzeit kann sich hier nichts mehr ändern.
 *   - Vom Telefon führt kein Weg in die Aufnahme. Wer es doch versuchen will,
 *     braucht „Desktop-Website" im Browsermenü.
 *
 * Kopie: fast alles ist bestehender Text — Wortmarke und die zwei
 * Untertitelzeilen des Geräts, die vier Zeilen der Tippschleife, und als die
 * drei Fakten `info.what1/3/4` aus dem Info-Fenster (dort schon in fünf
 * Sprachen und in der Stimme des Owners geschrieben). Neu getextet ist nur der
 * Hinweis, wo das Werkzeug läuft.
 */
export function MobileView() {
  return (
    <main className="mobile">
      <header className="mobile__head">
        <h1 className="mobile__wordmark">
          {t('header.brandLocal')}
          <span className="mobile__rec">{t('header.brandRec')}</span>
        </h1>
        <div className="mobile__rule" role="presentation" />
        <p className="mobile__lead">{t('header.subtitleTagline')}</p>
        <p className="mobile__lead">{t('header.subtitleFlightMode')}</p>
      </header>

      {/* Das Gerät bei der Arbeit — dieselbe `DemoLoop`, die am Desktop im
          Display tippt, im selben doppelten Bezel. `DemoLoop` setzt sein
          `aria-hidden` selbst; die Aussage dahinter steht als echter Text in
          der Faktenliste unten, nichts geht Screenreadern verloren. */}
      <div className="mobile__panel">
        <div className="mobile__screen">
          <DemoLoop />
        </div>
      </div>

      <section className="mobile__handoff">
        <p className="mobile__handoff-label">{t('mobile.runsOnDesktopLabel')}</p>
        <p className="mobile__handoff-body">{t('mobile.runsOnDesktopBody')}</p>
      </section>

      <ul className="mobile__facts">
        <li className="mobile__fact">{t('info.what1')}</li>
        <li className="mobile__fact">{t('info.what3')}</li>
        <li className="mobile__fact">{t('info.what4')}</li>
      </ul>
    </main>
  );
}
