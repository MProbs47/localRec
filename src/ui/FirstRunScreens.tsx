import type { ImportPhase } from '../session/importPipeline';
import { t } from '../i18n';
import { formatElapsedShort } from './format';
import { RecordingDots } from './RecordingDots';

/**
 * U8: the four `first-run`-wrapped screens extracted from the deleted
 * `ScreenContent`'s `idle`/`downloading`/`importing`/`error` branches —
 * these are the genuinely-new (i.e. not a verbatim move) pieces of that
 * extraction, since each now takes only its own props instead of the full
 * 22-prop pass-through. They share the `first-run` CSS wrapper.
 *
 * NOTE: there used to be an unrelated `src/ui/FirstRun.tsx` (U11's guided
 * OPFS-download component, kept as deferred dead code per the "Model cache
 * Variante A" decision) — it was deleted as dead code (never wired up);
 * this file was always named differently and never depended on it.
 */

/** §1: the model load is user-initiated — nothing is fetched until this. */
export function IdleScreen({ onStartDownload }: { onStartDownload: () => void }) {
  return (
    <div className="first-run" data-status="idle">
      <p className="first-run__message">{t('firstRun.idleMessage')}</p>
      <button type="button" className="first-run__action" onClick={onStartDownload}>
        {t('firstRun.startDownload')}
      </button>
    </div>
  );
}

export function DownloadingScreen({ loadProgress }: { loadProgress: number }) {
  const mb = Math.round(loadProgress * 1500);
  return (
    <div className="first-run" data-status="downloading">
      <p className="first-run__message">{t('firstRun.downloadingMessage')}</p>
      <progress className="first-run__progress" value={loadProgress} max={1} />
      <p className="first-run__progress-label">
        {t('firstRun.downloadProgress', { mb, pct: Math.round(loadProgress * 100) })}
      </p>
    </div>
  );
}

/**
 * U20b decode + batch-transcribe. Whisper's long-form transcription reports
 * NO mid-inference progress (only 0→1, see `whisperEngine.transcribe`), so a
 * percentage bar would sit at 0 % for the whole multi-minute run and read as
 * "hung" (it isn't — a 14-min file just takes minutes). Show an HONEST signal
 * instead: the phase label, activity dots, and an elapsed timer that actually
 * moves — plus a reassurance once it has run a while.
 */
export function ImportingScreen({
  importPhase,
  importElapsedMs,
}: {
  importPhase: ImportPhase;
  importElapsedMs: number;
}) {
  const label = importPhase === 'decoding' ? t('firstRun.decodingLabel') : t('firstRun.transcribingLabel');
  return (
    <div className="first-run" data-status="importing">
      <p className="first-run__message">
        {label} <RecordingDots />
      </p>
      <p className="first-run__progress-label">
        {t('firstRun.elapsedSince', { elapsed: formatElapsedShort(importElapsedMs) })}
      </p>
      {importElapsedMs >= 90_000 && (
        <p className="first-run__progress-label first-run__progress-label--note">
          {t('firstRun.longRunningNote')}
        </p>
      )}
    </div>
  );
}

export function ErrorScreen({
  errorHeadline,
  errorMessage,
  modelLoadFailed,
  onStartDownload,
}: {
  /** U20b: the `error` screen's headline — context-dependent (model load vs. import), see `App`'s `errorHeadline` state. */
  errorHeadline: string;
  errorMessage: string | null;
  /** #6: whether the current error screen is a retryable model-load failure — shows the "Erneut versuchen" button. */
  modelLoadFailed: boolean;
  onStartDownload: () => void;
}) {
  return (
    <div className="first-run first-run--error" role="alert">
      <p className="first-run__message">{errorHeadline}</p>
      <p className="first-run__error-detail">{errorMessage}</p>
      {/* #6: a transient model-download blip no longer bricks the session —
          offer a retry (only for model-load failures, not import errors). */}
      {modelLoadFailed && (
        <button type="button" className="first-run__action" onClick={onStartDownload}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
