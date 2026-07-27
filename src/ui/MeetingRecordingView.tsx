import { t } from '../i18n';
import { RecordingDots } from './RecordingDots';

/**
 * Plan 003 record-only meeting — the in-call screen. No live transcript (the
 * meeting isn't transcribed until after stop), just a calm "AUFNAHME LÄUFT"
 * with cumulative blinking dots. The VU meter beside the panel shows the level.
 *
 * U8: moved out of `App.tsx` verbatim.
 *
 * **`micSilent` (owner feedback 2026-07-27).** The one thing this otherwise
 * calm screen must be able to interrupt with: the microphone branch has been
 * delivering silence since the start (`LiveCapture`'s mic watch — see
 * `MIC_SILENCE_THRESHOLD` there for why the VU meter can't show this during
 * a meeting). It REPLACES the ordinary hint rather than adding a third line:
 * the ordinary hint says the recording is running, which is still true and
 * far less important than "your own voice isn't in it". The recording is
 * never stopped over this — that stays the user's call.
 */
export interface MeetingRecordingViewProps {
  /** True once the mic-silence watch reported nothing but silence from the microphone. */
  micSilent?: boolean;
}

export function MeetingRecordingView({ micSilent = false }: MeetingRecordingViewProps) {
  return (
    <div className="meeting-recording" data-status="recording" data-mic-silent={micSilent}>
      <p className="meeting-recording__label">
        {t('meeting.recordingLabel')}
        <RecordingDots />
      </p>
      <p className="meeting-recording__hint">
        {micSilent ? t('meeting.micSilentHint') : t('meeting.recordingHint')}
      </p>
    </div>
  );
}
