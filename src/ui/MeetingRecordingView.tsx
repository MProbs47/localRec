import { t } from '../i18n';
import { RecordingDots } from './RecordingDots';

/**
 * Plan 003 record-only meeting — the in-call screen. No live transcript (the
 * meeting isn't transcribed until after stop), just a calm "AUFNAHME LÄUFT"
 * with cumulative blinking dots. The VU meter beside the panel shows the level.
 *
 * U8: moved out of `App.tsx` verbatim.
 */
export function MeetingRecordingView() {
  return (
    <div className="meeting-recording" data-status="recording">
      <p className="meeting-recording__label">
        {t('meeting.recordingLabel')}
        <RecordingDots />
      </p>
      <p className="meeting-recording__hint">{t('meeting.recordingHint')}</p>
    </div>
  );
}
