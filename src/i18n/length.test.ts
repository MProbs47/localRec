import { afterEach, describe, expect, it as vitestIt } from 'vitest';
import type { StringKey } from './index';
import { de } from './strings.de';
import { en } from './strings.en';
import { it } from './strings.it';
import { fr } from './strings.fr';
import { es } from './strings.es';
import { t } from './index';
import { setLocale } from './locale';

/**
 * The Längen-Guard (KTD13, U4 approach step 5/plan R4): a deterministic test
 * standing in for a screenshot suite. It catches "Französisch sprengt das
 * Layout" (R4) without any screenshot infrastructure.
 *
 * NOT tested here: table completeness. `Record<StringKey, string>` on every
 * `strings.*.ts` module makes a missing/extra key a TypeScript error (KTD2)
 * — that IS the completeness proof. A runtime sync test on top of the type
 * would be redundant; don't add one later.
 */

// ---------------------------------------------------------------------------
// Layout-critical keys — pulled from the real layout in `src/ui/theme.css`,
// not guessed from the key names. Each group below names the CSS rule that
// makes it tight:
//   - `.step` (theme.css ~L644): `grid-template-columns: 1.4em 1fr auto`,
//     `font-size: clamp(11px, 1vw, 14px)` — a label long enough to wrap
//     breaks the "three lines fit under the display" contract the file's
//     own comment states (padding is tuned to exactly three single lines).
//   - `.mode-toggle__option` (theme.css ~L882): fixed `padding: 8px 18px`
//     row of three adjacent buttons — no `white-space: nowrap`, but three
//     of them side by side is the row the design renders as one continuous
//     switcher.
//   - `.recovery__option`, `.annotation-action`: the app's small
//     "Knopfbeschriftung" button language (screen buttons), same shape as
//     `.import-view__action`/`.setup-view__action`.
//   - `.panel__engraving` (theme.css ~L520): the two engravings under the
//     display's bottom edge, `white-space: nowrap` and pinned to opposite
//     corners of `.panel-wrap` — a long enough pair collides in the middle.
//   - `demo.line*`: `DemoLoop.tsx`'s typewriter slices these
//     character-by-character — a much longer line changes the loop's own
//     timing, not just its width.
const LAYOUT_CRITICAL_KEYS: readonly StringKey[] = [
  // Knopfbeschriftungen (general button labels)
  'record.startLabel',
  'record.stopLabel',
  'firstRun.startDownload',
  'import.pickFile',
  'common.retry',
  // `Steps.tsx` status labels (`.step`, three-lines-under-the-display
  // constraint above)
  'steps.transcriptionDone',
  'steps.recordingStopped',
  'steps.savedIn',
  'steps.saved',
  'steps.saving',
  'steps.speakersDetected',
  'steps.finishedSaved',
  'steps.modelLoaded',
  'steps.locationSet',
  'steps.locationChooseFolder',
  'steps.locationChooseAtStart',
  'steps.transcribingFile',
  'steps.pickAndTranscribe',
  'steps.meetingTranscribing',
  'steps.recordMeeting',
  'steps.recording',
  // `ModeToggle.tsx` options (`.mode-toggle__option`)
  'mode.record',
  'mode.import',
  'mode.meeting',
  // `DemoLoop.tsx` typewriter lines
  'demo.line1',
  'demo.line2',
  'demo.line3',
  'demo.line4',
  // `StoppedScreen.tsx` action buttons (`.annotation-action`) — NOT the
  // numeric speaker-count chips (`.annotation-count__chip`), which sit in a
  // `flex-wrap: wrap` row with no nowrap/fixed width and so carry no layout
  // risk of this kind.
  'stopped.retryDetection',
  'stopped.reDetect',
  'stopped.detectSpeakers',
  // `RecordSetupView.tsx`/`MeetingView.tsx`/`ImportView.tsx` folder-first
  // gate buttons (`.setup-view__action`)
  'setup.chooseLocation',
  'setup.chooseFolder',
  // `RecoveryScreen.tsx` (`.recovery__option`)
  'recovery.resume',
  'recovery.discard',
  // The two `.panel__engraving` labels under the display (`App.tsx`)
  'clear.withRefresh',
  'info.buttonLabel',
];

// Measured (not guessed) after the first translation pass across it/fr/es
// over the list above: the real maximum is factor 1.75 — `steps.recording`
// ("Aufnahme" → fr "Enregistrement"), a case where the German source is an
// unusually short bare noun and French/Italian have no shorter honest
// synonym for "recording" as a noun (checked; not fixable by rewording). The
// runner-up cluster sits at 1.5–1.65 (`record.startLabel`, `record.stopLabel`,
// `mode.import`, `setup.chooseFolder`, all fr). 1.8 sits just
// above the real 1.75 max — enough headroom for the measured data, not a
// pre-guessed round number. If a future translation trips this, shorten the
// wording first (approach step 6); only touch `theme.css` if no shorter
// phrasing carries the meaning, and never raise this number to make a
// specific overlong string pass.
const MAX_LENGTH_FACTOR = 1.8;

describe('length guard (KTD13) — layout-critical keys stay within reach of the German length', () => {
  // Code-review Befund 6: `en` joined it/fr/es here. R2 makes English the
  // FALLBACK for every unsupported browser language — so it's not just one
  // more locale among five, it's the one every visitor whose browser isn't
  // de/it/fr/es actually sees, which makes it the most-served table with no
  // layout check at all before this. The measured en/de max is ~1.13× (well
  // under the existing 1.8 limit, which stays exactly as calibrated above —
  // this only adds a table to the existing check, it doesn't move the bar).
  const tables: Record<'en' | 'it' | 'fr' | 'es', Record<StringKey, string>> = { en, it, fr, es };

  for (const key of LAYOUT_CRITICAL_KEYS) {
    vitestIt(`${key}: en/it/fr/es do not exceed ${MAX_LENGTH_FACTOR}× the German length`, () => {
      const deLength = de[key].length;
      const limit = Math.ceil(deLength * MAX_LENGTH_FACTOR);
      for (const [lang, table] of Object.entries(tables) as [string, Record<StringKey, string>][]) {
        const value = table[key];
        expect(
          value.length,
          `${key} [${lang}] is ${value.length} chars ("${value}"), over the limit of ${limit} chars ` +
            `(${MAX_LENGTH_FACTOR}× the German ${deLength}-char "${de[key]}")`,
        ).toBeLessThanOrEqual(limit);
      }
    });
  }
});

describe('no forgotten copy-paste rows — it/fr/es differ from German, nothing is empty', () => {
  // Keys that are deliberately BYTE-IDENTICAL across all five tables —
  // device labels/brand, not language (see the matching comments in
  // `strings.en.ts`) — plus one numeric progress format with no
  // natural-language content at all (only a placeholder and units).
  const UNTRANSLATED_KEYS: ReadonlySet<StringKey> = new Set<StringKey>([
    'header.brandLocal',
    'header.brandRec',
    'device.recBadge',
    'device.status',
    'device.lineInLabel',
    'transcript.jumpToLive',
    'vu.label',
    'format.hours',
    'format.minutes',
    'language.de',
    'language.en',
    'language.it',
    'language.fr',
    'language.es',
    // '{mb} MB / ~1500 MB · {pct}%' — placeholders + units only, nothing to
    // translate; already identical between `en.ts` and `de.ts` since U3.
    'firstRun.downloadProgress',
    // "Auto" — the first chip in `StoppedScreen`'s speaker-count row, whose
    // other members are bare numerals (1, 2, 3, …) in the same mono chip
    // style. The abbreviation reads in all five languages; spelling it out
    // ("Automatico"/"Automatique") would make one chip ~2.5x its numeric
    // neighbours and break the row. The exception belongs here, in the test
    // — never widen a UI string to satisfy this heuristic.
    'stopped.autoChip',
  ]);

  const tables: Record<'it' | 'fr' | 'es', Record<StringKey, string>> = { it, fr, es };
  const allKeys = Object.keys(de) as StringKey[];

  for (const [lang, table] of Object.entries(tables) as [string, Record<StringKey, string>][]) {
    vitestIt(`${lang}: no empty values, no accidental German copy-paste`, () => {
      for (const key of allKeys) {
        const value = table[key];
        expect(value.trim().length > 0, `${key} [${lang}] is empty`).toBe(true);
        if (!UNTRANSLATED_KEYS.has(key)) {
          expect(value, `${key} [${lang}] is byte-identical to the German original — forgotten translation?`).not.toBe(
            de[key],
          );
        }
      }
    });
  }
});

describe('setLocale switches t() output (spot check)', () => {
  // The suite-wide German-locale pin lives in `vitest.setup.ts`; any test here
  // that moves the locale restores it, so state doesn't leak into other test
  // files.
  afterEach(() => {
    setLocale('de');
  });

  vitestIt('setLocale("fr") renders French text; setLocale("de") restores German', () => {
    setLocale('fr');
    expect(t('record.startLabel')).toBe("Démarrer l'enregistrement");
    expect(t('common.retry')).toBe('Réessayer');
    expect(t('speaker.label', { n: 1 })).toBe('Locuteur 1');

    setLocale('de');
    expect(t('record.startLabel')).toBe('Aufnahme starten');
    expect(t('common.retry')).toBe('Erneut versuchen');
    expect(t('speaker.label', { n: 1 })).toBe('Sprecher 1');
  });
});
