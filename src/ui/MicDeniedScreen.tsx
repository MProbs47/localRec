import { t } from '../i18n';

export interface MicDeniedScreenProps {
  /** Re-attempts the recording in place — `getUserMedia` re-checks live permission each call, so no page reload is needed once the user has allowed the mic in the browser. */
  onRetry: () => void;
}

/**
 * Shown on the record-mode `ready` screen after `getUserMedia` was denied /
 * failed (see `App.tsx`'s `startRecording`). Deliberately NOT a `deviceState`
 * of its own: the device stays `ready`, so the physical RecordButton is also
 * live — this screen just names why the last attempt didn't start and offers a
 * one-click in-place retry (the browser shows its own permission UI alongside).
 * Reuses the `first-run--error` visual language of the model/import error
 * screen (`FirstRunScreens.tsx`'s `ErrorScreen`).
 */
export function MicDeniedScreen({ onRetry }: MicDeniedScreenProps) {
  return (
    <div className="first-run first-run--error" role="alert">
      <p className="first-run__message">{t('mic.deniedHeadline')}</p>
      <p className="first-run__error-detail">{t('mic.deniedDetail')}</p>
      <button type="button" className="first-run__action" onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}
