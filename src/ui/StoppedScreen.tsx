import { useEffect, useState } from 'react';
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
  /**
   * Firefox/Safari fallback-honesty fix (owner-reported bug, the "U9/U12a
   * gap" this App.tsx header comment names): collects every file the
   * session's sink is holding that never reached a real chosen folder —
   * either the whole session ran on the OPFS `FallbackSink`, or a
   * live-mirror `FileSystemAccessSink` degraded to it mid-session (R7
   * Grenzfall). `undefined`/an empty result renders no section at all —
   * the ordinary case where a real folder was chosen and nothing degraded.
   * Called again whenever `annotation` changes (see the effect below): the
   * post-hoc `-sprecher.txt`/`.srt` files (`writeSpeakerTranscripts`, App.tsx)
   * are written to the SAME sink instance only after annotation finishes, so
   * a one-shot collection at stop would silently miss them.
   */
  collectDownloads?: () => Promise<Map<string, Blob>>;
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
  collectDownloads,
}: StoppedScreenProps) {
  const actionLabel =
    annotation === 'skipped'
      ? t('stopped.retryDetection')
      : annotation === 'done'
        ? t('stopped.reDetect')
        : t('stopped.detectSpeakers');

  return (
    <>
      <DownloadSection collectDownloads={collectDownloads} annotation={annotation} />
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

/** One collected file, with its own object URL — created once per `collectDownloads()` resolution, revoked together (see the effect below). */
interface DownloadEntry {
  name: string;
  url: string;
}

/**
 * Firefox/Safari fallback-honesty fix: the end-of-session download
 * affordance for whatever `collectDownloads` (see `StoppedScreenProps`)
 * hands back. Renders nothing while `collectDownloads` is absent or its
 * result is empty — the ordinary "a real folder was chosen, nothing
 * degraded" case.
 *
 * A small component of its own (not inlined into `StoppedScreen`) purely so
 * the object-URL lifecycle — create on every (re-)collect, revoke the
 * PREVIOUS batch on the next collect or on unmount — has one effect to own,
 * instead of tangling it into the parent's render.
 */
function DownloadSection({
  collectDownloads,
  annotation,
}: {
  collectDownloads?: () => Promise<Map<string, Blob>>;
  /** Re-run the collection whenever this changes — `writeSpeakerTranscripts` (App.tsx) adds the `-sprecher.*` files to the SAME sink only once this reaches 'done'. */
  annotation: 'idle' | 'running' | 'done' | 'skipped';
}) {
  const [entries, setEntries] = useState<DownloadEntry[]>([]);

  useEffect(() => {
    if (!collectDownloads) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    let createdUrls: string[] = [];
    void collectDownloads().then((files) => {
      if (cancelled) return;
      const next = Array.from(files, ([name, blob]) => ({ name, url: URL.createObjectURL(blob) }));
      createdUrls = next.map((entry) => entry.url);
      setEntries(next);
    });
    return () => {
      cancelled = true;
      // Revokes THIS effect run's own URLs — either superseded by a fresh
      // collect (annotation changed) or the screen unmounting (a new
      // recording/import started, or the user navigated away).
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [collectDownloads, annotation]);

  if (entries.length === 0) return null;

  return (
    <div className="download-section" role="group" aria-label={t('stopped.downloadsHeading')}>
      <p className="download-section__note">{t('stopped.downloadsNote')}</p>
      <div className="download-section__list">
        {entries.map((entry) => (
          <a key={entry.name} className="download-section__link" href={entry.url} download={entry.name}>
            {entry.name}
          </a>
        ))}
      </div>
    </div>
  );
}
