import type { AlignedSegment } from '../diarization/align';
import { t } from '../i18n';
import { LiveTranscript } from './LiveTranscript';
import { RecordingDots } from './RecordingDots';
import { SpeakerView } from './SpeakerView';
import type { TranscriptStore } from './transcriptStore';

/**
 * The selectable known-speaker-counts. Up to 8 because AUTO structurally cannot
 * resolve large circles: its 10 % speech-time floor (`minSpeakerShare`) folds
 * every speaker holding less — with 7–8 people several always do. Stating the
 * count disables that floor, so for big meetings the chip is the ONLY reliable
 * path, not a convenience. Beyond 8, meeting audio (far mics, crosstalk) is
 * past what this embedding pipeline can separate honestly.
 */
const SPEAKER_COUNT_CHOICES = [2, 3, 4, 5, 6, 7, 8] as const;

export interface StoppedScreenProps {
  store: TranscriptStore;
  /** Phase D (U18): the speaker-labeled result — when set, shows `SpeakerView` instead of the plain `LiveTranscript`. */
  aligned: AlignedSegment[] | null;
  /** Phase D (U18/U21): the post-hoc annotate stage status — drives the visible "Sprecher werden erkannt …" line. */
  annotation: 'idle' | 'running' | 'done' | 'skipped';
  /** Phase D (U18): why diarization was skipped (error message), or null on the clean/empty skip. */
  annotationError: string | null;
  /** Phase D (hybrid timing): whether recorded audio is parked for on-demand diarization (→ show the "Sprecher erkennen" button). */
  canAnnotate: boolean;
  /** Phase D (hybrid timing): runs the on-demand diarization. */
  onAnnotate: () => void;
  /** Round 5: the user-stated speaker count (null = automatic) fed to the next run as `knownSpeakerCount`. */
  speakerCount: number | null;
  onSpeakerCountChange: (count: number | null) => void;
}

/**
 * The post-recording/post-import finalize screen (U8: extracted from the
 * deleted `ScreenContent`'s `'stopped'` branch). Once the post-hoc annotation
 * is done, the plain transcript is replaced by the speaker-labeled
 * `SpeakerView`. While it runs, the plain transcript stays up with a small
 * progress line above it; on the SD-3 skip (model absent / diarization
 * failed), `aligned` stays null and the plain transcript simply remains — no
 * error, no speaker artifact.
 *
 * The speaker-count chips (round 5): the user usually KNOWS how many people
 * spoke, and saying so removes the count decision from the clustering. One
 * shared row for all three entry states — first run (idle), retry (skipped),
 * and correction after a wrong automatic result (done) — because it is the
 * same action with the same knob.
 */
export function StoppedScreen({
  store,
  aligned,
  annotation,
  annotationError,
  canAnnotate,
  onAnnotate,
  speakerCount,
  onSpeakerCountChange,
}: StoppedScreenProps) {
  const actionLabel =
    annotation === 'skipped'
      ? t('stopped.retryDetection')
      : annotation === 'done'
        ? t('stopped.reDetect')
        : t('stopped.detectSpeakers');

  return (
    <>
      {/* Hybrid timing: for live/meeting the diarization is on demand — the
          transcript is already saved; this button runs the slow speaker step
          when the user is ready. After a done run the same row stays available
          to re-run with a stated count (import auto-runs land here too). */}
      {annotation !== 'running' && canAnnotate && (
        <div className="annotation-controls">
          <div className="annotation-count" role="group" aria-label={t('stopped.speakerCountAriaLabel')}>
            <span className="annotation-count__label">
              {annotation === 'done' ? t('stopped.correctSpeakerCount') : t('stopped.speakerCountLabel')}
            </span>
            <button
              type="button"
              className={`annotation-count__chip${speakerCount === null ? ' annotation-count__chip--active' : ''}`}
              aria-pressed={speakerCount === null}
              onClick={() => onSpeakerCountChange(null)}
            >
              {t('stopped.autoChip')}
            </button>
            {SPEAKER_COUNT_CHOICES.map((n) => (
              <button
                key={n}
                type="button"
                className={`annotation-count__chip${speakerCount === n ? ' annotation-count__chip--active' : ''}`}
                aria-pressed={speakerCount === n}
                onClick={() => onSpeakerCountChange(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <button type="button" className="annotation-action" onClick={onAnnotate}>
            {actionLabel}
          </button>
        </div>
      )}
      {annotation === 'running' && (
        <p className="annotation-status" role="status">
          {t('annotation.detecting')} <RecordingDots />
        </p>
      )}
      {annotation === 'skipped' && annotationError && (
        <p className="annotation-status annotation-status--error" role="alert">
          {t('stopped.detectionUnavailable', { error: annotationError })}
        </p>
      )}
      {aligned ? <SpeakerView segments={aligned} /> : <LiveTranscript store={store} interimActive={false} />}
    </>
  );
}
