/**
 * The record-mode setup screen — folder-and-microphone FIRST, start second.
 *
 * Why this exists (hardware test 01, finding 1): the first press of the red
 * button used to ask for the MICROPHONE, and only then — mid-start, after the
 * permission dialog — pop the folder picker. Two system dialogs in a row, in
 * the wrong order, with nothing on screen explaining either. Users didn't
 * understand what was being asked. Now the setup is one deliberate step of its
 * own ("Speicherort wählen", which also asks for the mic right after the
 * picker closes), and the red button does nothing but START — instantly, with
 * no dialog in the way.
 *
 * The note about what gets written sits BESIDE the button, not under it: the
 * record button overlaps the screen's bottom edge, so a full-width line down
 * there is half-hidden behind it (hardware test 02, finding 3).
 *
 * The screen used to also carry S2's red "Alle Aufnahmen löschen" button as
 * `children` in the same row grid; that action is now the "clear with
 * refresh" engraving under the display (owner feedback, 2026-07-26 — see
 * `App.tsx`'s `handleClearAndRefresh`), so the row is back to its two
 * original members: the button in column 1, the note beside it in column 2.
 *
 * Deliberately the SAME two-state shape and screen language as `MeetingView`
 * (Plan 003's folder-first KTD-M6 posture, which had this right already) and
 * `ImportView`; it reuses their `.meeting-view` styling (see `theme.css`) so
 * all three landings read as one device.
 */
import { t } from '../i18n';

export function RecordSetupView({
  hasOutputTarget,
  outputName,
  onChooseFolder,
  languageControl,
  sinkIsFallback = false,
}: {
  hasOutputTarget: boolean;
  outputName: string | null;
  onChooseFolder: () => void;
  /** The shared transcription-language dropdown (`LanguageSelect`, owned by App) — rendered once the folder is set. */
  languageControl?: React.ReactNode;
  /**
   * Firefox/Safari fallback-honesty fix (owner-reported bug): true once the
   * active sink resolved to the OPFS `FallbackSink` (`fileSink.ts`'s
   * `FileSink.kind === 'fallback'`) — no folder picker was ever shown, so
   * `outputName` is `null` for a reason other than a genuine ready-without-
   * folder gap. When true, the "ready" note below must NOT read like a
   * folder was chosen (App.tsx tracks this in `sinkIsFallback`).
   */
  sinkIsFallback?: boolean;
}) {
  if (!hasOutputTarget) {
    return (
      <div className="setup-view" data-status="needs-folder">
        <p className="setup-view__message">{t('setup.micFolderMessage')}</p>
        <div className="setup-view__row">
          <button type="button" className="setup-view__action" onClick={onChooseFolder}>
            {t('setup.chooseLocation')}
          </button>
          <p className="setup-view__note">{t('setup.writeNote')}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="setup-view" data-status="ready">
      <p className="setup-view__message">{t('setup.readyMessage')}</p>
      {/* `--wide` (theme.css): the fallback sentence is longer than the short
          "Speicherort …" receipt line the 42ch cap was tuned for — scoped to
          this case only so it doesn't wrap into the fixed-height `.screen`
          box and push the consent sentence/`LanguageSelect` out of view
          (owner-reported bug, 2026-07-26 hardware test). */}
      <p className={sinkIsFallback ? 'setup-view__note setup-view__note--wide' : 'setup-view__note'}>
        {sinkIsFallback
          ? t('setup.readyNoteFallback')
          : outputName
            ? t('setup.readyNoteWithFolder', { folder: outputName })
            : t('setup.readyNoteDefault')}
      </p>
      {/* U6/R11/KTD11: one sentence, no checkbox, no gating — the sentence
          IS the measure. Rendered ONLY here in the `ready` state (folder set,
          red button unlocked, start imminent). Never in `needs-folder`
          above: nothing to confirm yet, attention belongs to the folder.
          Owner feedback (2026-07-26): it swapped places with the language
          dropdown. It used to be the LAST line, immediately above the button
          — but `RecordButton` punches through the screen's bottom edge
          (theme.css `.record-button`), so the last line is the one that gets
          cut in half. Of the two, the consent sentence is the one that must
          stay readable; the dropdown below it is a control, still fully
          usable with its bottom edge grazed. */}
      <p className="consent-note">{t('consent.note')}</p>
      {languageControl}
    </div>
  );
}
