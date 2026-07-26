/**
 * U5 (KTD8/KTD9/KTD10) — the info view, opened by the "How it works"
 * engraving under the display's bottom-right corner (idle/ready only, see
 * `App.tsx`). Every visible word comes from `t()`; the only state it owns is
 * the per-prompt "copied"/"failed" clipboard feedback (`PromptBlock` below)
 * and the open-focus handoff — no `deviceState`, no store.
 *
 * **Owner feedback (2026-07-26): a pop-up, not a display swap.** U5 built
 * this as a swap of the `.screen` content (KTD8), which meant the info text
 * inherited the resting display's height and pushed the whole device around
 * when it opened. It is now a modal that LOOKS like the display itself — the
 * same double bezel + black screen (`.info-modal__panel`/`__screen` in
 * theme.css), centred over a dimmed page, scrolling internally when the
 * prose outgrows the viewport. Deliberately still no focus TRAP (YAGNI, one
 * dialog, no forms): the close button takes focus on open, `Escape` and a
 * backdrop click both close, and `App.tsx` disables the record button and
 * the device knob while it is open so nothing behind it can be triggered by
 * accident. `onClose` is called by all three paths — the "Zurück" button, the
 * backdrop, and `App.tsx`'s keydown effect (`Escape`).
 *
 * Layout mirrors the plan's "Textquellen" section literally: four sections —
 * (1) five architecture sentences, (2) three guide steps, (3) the summary
 * intro + the KTD10 device-limit sentence + two copyable prompts, (4) the
 * as-is disclaimer. The five sentences and three steps are each rendered as
 * their OWN `<li>` (not one text block) — `InfoView.test.tsx` counts these
 * elements rather than asserting on wording, so future copy edits (the U5b
 * it/fr/es translations already among them) can't break that test as long as
 * the count stays 5/3.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

/**
 * One copyable LLM prompt: a `<pre>` block (always visible, selectable by
 * hand regardless of clipboard support) plus a "Kopieren" button that calls
 * `navigator.clipboard.writeText` inside this click's user gesture. Per the
 * plan (approach step 5): no `document.execCommand` fallback, no toast
 * system — a missing `navigator.clipboard` or a rejected promise just shows
 * the failure inline and never throws.
 */
function PromptBlock({ label, text }: { label: string; text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = () => {
    const clipboard = typeof navigator === 'object' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setStatus('failed'); // no Clipboard API at all — text stays selectable in the <pre> above
      return;
    }
    clipboard.writeText(text).then(
      () => setStatus('copied'),
      () => setStatus('failed'), // rejected promise (permission denied, insecure context, ...) — never throws
    );
  };

  return (
    <div className="info-view__prompt">
      <p className="info-view__prompt-label">{label}</p>
      <pre className="info-view__prompt-text">{text}</pre>
      <div className="info-view__prompt-actions">
        <button
          type="button"
          className="info-view__copy"
          onClick={handleCopy}
          aria-label={`${t('info.copyLabel')}: ${label}`}
        >
          {t('info.copyLabel')}
        </button>
        {status === 'copied' && <span className="info-view__copy-feedback">{t('info.copiedLabel')}</span>}
        {status === 'failed' && (
          <span className="info-view__copy-feedback info-view__copy-feedback--failed">
            {t('info.copyFailedLabel')}
          </span>
        )}
      </div>
    </div>
  );
}

export function InfoView({ onClose }: { onClose: () => void }) {
  // The only focus handling this dialog does (see the header comment): move
  // focus onto the close button when it opens, so `Tab`/`Enter` land inside
  // the pop-up instead of on whatever was focused behind it.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div className="info-modal" role="dialog" aria-modal="true" aria-label={t('info.buttonLabel')}>
      {/* Dimmed page behind the pop-up. Click-to-close is a convenience, not
          the only way out — `Escape` and the "Zurück" button are the
          keyboard-reachable paths, so this stays out of the a11y tree
          instead of becoming a second button with the same name. */}
      <div className="info-modal__backdrop" aria-hidden="true" onClick={onClose} />
      <div className="info-modal__panel">
        <div className="info-modal__screen">
          <div className="info-view">
            {/* Own sticky row rather than a sticky button: the button is a
                small pill, so the prose would scroll visibly through the gap
                beside it. The row carries the display's own background and
                the screen's top padding, so the text passes cleanly BEHIND
                it (theme.css `.info-view__bar`). */}
            <div className="info-view__bar">
              <button type="button" className="info-view__back" ref={closeRef} onClick={onClose}>
                {t('info.backLabel')}
              </button>
            </div>

            <section className="info-view__section">
              <h2 className="info-view__heading">{t('info.whatHeading')}</h2>
              <ul className="info-view__list">
                <li>{t('info.what1')}</li>
                <li>{t('info.what2')}</li>
                <li>{t('info.what3')}</li>
                <li>{t('info.what4')}</li>
                <li>{t('info.what5')}</li>
              </ul>
            </section>

            <section className="info-view__section">
              <h2 className="info-view__heading">{t('info.stepsHeading')}</h2>
              <ol className="info-view__list">
                <li>{t('info.step1')}</li>
                <li>{t('info.step2')}</li>
                <li>{t('info.step3')}</li>
              </ol>
            </section>

            <section className="info-view__section">
              <h2 className="info-view__heading">{t('info.summaryHeading')}</h2>
              <p>{t('info.summaryIntro')}</p>
              {/* KTD10, not negotiable — see this component's own doc comment. */}
              <p className="info-view__device-limit">{t('info.summaryDeviceLimit')}</p>
              <PromptBlock label={t('info.promptSpeakerLabel')} text={t('info.promptSpeakerText')} />
              <PromptBlock label={t('info.promptSimpleLabel')} text={t('info.promptSimpleText')} />
            </section>

            <section className="info-view__section">
              <h2 className="info-view__heading">{t('info.disclaimerHeading')}</h2>
              <p>{t('info.disclaimerText')}</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
