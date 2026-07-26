import { t } from '../i18n';

/** The decorative "LINE IN" jack in the footer (§3). U8: moved out of `App.tsx` verbatim. */
export function LineInJack() {
  return (
    <div className="jack">
      <span className="jack__socket" aria-hidden="true">
        <span className="jack__ring-outer">
          <span className="jack__ring-inner" />
        </span>
      </span>
      <span className="jack__label">{t('device.lineInLabel')}</span>
    </div>
  );
}
