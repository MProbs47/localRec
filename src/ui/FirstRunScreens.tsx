import { useState } from 'react';
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

/**
 * The error screen. Beyond the headline + one-line detail it has carried
 * since U20b, a *coded* failure (today: `AudioDecodeError`, see
 * `audioDecode.ts`) also gets its code and a "Copy error details" button.
 *
 * **Why the code and the button and nothing more.** The screen is inside the
 * device display and has room for about three lines; the support case that
 * motivated this involved a user whose organisation blocks DevTools, so the
 * report has to leave the machine through the clipboard rather than be read
 * on screen. Code + one line + one button is the whole visible surface; the
 * multi-line report stays behind the button.
 *
 * **English, not localised** — see `AUDIO_DECODE_CODE_DESCRIPTIONS`'s comment:
 * comparable support text beats a translated error code. The headline above
 * remains localised.
 *
 * The copy path mirrors `InfoView`'s `PromptBlock` (no `execCommand`
 * fallback, no toast system, never throws) with one addition: a *failed* copy
 * reveals the report in a `<pre>` so the text is still selectable by hand.
 * Without that, a browser with no Clipboard API would leave the user with no
 * way at all to get the report out — which is the one thing this screen
 * exists to prevent.
 */
export function ErrorScreen({
  errorHeadline,
  errorMessage,
  errorCode,
  errorDetails,
  modelLoadFailed,
  onStartDownload,
}: {
  /** U20b: the `error` screen's headline — context-dependent (model load vs. import), see `App`'s `errorHeadline` state. */
  errorHeadline: string;
  errorMessage: string | null;
  /** The machine-readable failure code, when the error carried one (`AudioDecodeErrorCode`). Rendered verbatim so the user can read it out over the phone. */
  errorCode?: string | null;
  /** The copy-paste support report, when one was collected (`audioDiagnostics.ts`). Gates the copy button. */
  errorDetails?: string | null;
  /** #6: whether the current error screen is a retryable model-load failure — shows the "Erneut versuchen" button. */
  modelLoadFailed: boolean;
  onStartDownload: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = () => {
    const clipboard = typeof navigator === 'object' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function' || !errorDetails) {
      setCopyStatus('failed'); // no Clipboard API — the <pre> below takes over
      return;
    }
    clipboard.writeText(errorDetails).then(
      () => setCopyStatus('copied'),
      () => setCopyStatus('failed'), // permission denied, insecure context, ... — never throws
    );
  };

  return (
    <div className="first-run first-run--error" role="alert">
      <p className="first-run__message">{errorHeadline}</p>
      {errorCode && <p className="first-run__error-code">{errorCode}</p>}
      <p className="first-run__error-detail">{errorMessage}</p>
      {errorDetails && (
        <button type="button" className="first-run__copy" onClick={handleCopy}>
          {copyStatus === 'copied' ? 'Copied' : copyStatus === 'failed' ? 'Copy failed — select below' : 'Copy error details'}
        </button>
      )}
      {errorDetails && copyStatus === 'failed' && <pre className="first-run__error-report">{errorDetails}</pre>}
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
