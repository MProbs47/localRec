/**
 * The "Online Meeting" landing screen (Plan 003 U4). Folder-first (KTD-M6):
 * until an output folder is chosen it offers only "Ordner wählen" — its own
 * gesture, the SAME handler the import path uses — because the later
 * start-click spends its one user gesture on `getDisplayMedia`'s picker and
 * can't also open the folder picker. Once the folder is set, it shows the
 * one-sentence share instruction (plus a headphones/echo aside), and the
 * RecordButton (App's `startMeeting`) does the capture. `hint` surfaces a
 * recoverable retry message (system-audio checkbox forgotten, capture
 * failed) without ever becoming an error screen.
 *
 * U8: moved out of `App.tsx` verbatim.
 */
import { t } from '../i18n';

export function MeetingView({
  hasOutputTarget,
  onChooseFolder,
  hint,
  languageControl,
}: {
  hasOutputTarget: boolean;
  onChooseFolder: () => void;
  hint: string | null;
  /** The shared transcription-language dropdown (`LanguageSelect`, owned by App) — rendered once the folder is set. */
  languageControl?: React.ReactNode;
}) {
  if (!hasOutputTarget) {
    return (
      <div className="meeting-view" data-status="needs-folder">
        <p className="meeting-view__message">{t('meeting.needsFolderMessage')}</p>
        <button type="button" className="meeting-view__action" onClick={onChooseFolder}>
          {t('setup.chooseFolder')}
        </button>
      </div>
    );
  }
  return (
    <div className="meeting-view" data-status="ready">
      <p className="meeting-view__message">{t('meeting.shareInstruction')}</p>
      <p className="meeting-view__aside">{t('meeting.aside')}</p>
      {/* U6/R11/KTD11: same consent sentence as `RecordSetupView`, same
          reasoning — one sentence, no checkbox, no gating, rendered only in
          this `ready` state.
          Owner feedback (2026-07-26): on this screen the sentence was
          invisible in practice. It was the LAST element, and `RecordButton`
          punches through the display's bottom edge right where it landed —
          on a three-line share instruction it fell off the screen entirely.
          Fixed on all three fronts the owner named: the instruction dropped
          its trailing "— so kommen Mikro und Meeting-Ton zusammen ins
          Transkript" clause (that IS what the whole mode does; saying it
          cost a line), which pulls the aside up, and the consent sentence
          takes the line the aside used to hold. The language dropdown moves
          last, matching `RecordSetupView`: it's a control, still usable with
          its bottom edge grazed, where a half-cut sentence is not readable. */}
      <p className="consent-note">{t('consent.note')}</p>
      {languageControl}
      {hint && (
        <p className="meeting-view__hint" role="alert">
          {hint}
        </p>
      )}
    </div>
  );
}
