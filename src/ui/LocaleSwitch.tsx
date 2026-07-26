/**
 * The visible UI-language switcher (KTD17, U4 part b): flag + a native
 * `<select>`, top-right corner of the header.
 *
 * **Owner feedback after hardware test (2026-07-26):** this used to be a
 * cycle button — one click advanced `de → en → it → fr → es → de`. Reaching
 * Spanish meant four clicks through three languages you don't read, and the
 * button's own tooltip ("Sprache wechseln zu …") ran off the right edge of
 * the viewport. It is a dropdown now: every language one selection away,
 * listed by its two-letter code (`DE`/`EN`/`IT`/`FR`/`ES`) — device lettering
 * in the housing's corner, not prose. Same `<select>`-not-custom-machinery
 * posture as `LanguageSelect` (the RECORDING language) — YAGNI, and a native
 * listbox is the only one that behaves correctly on touch and with a screen
 * reader.
 *
 * The flag stays: it is the only thing that identifies the control at a
 * glance before you read it, and it renders as five tiny inline SVGs — no
 * emoji, no external asset:
 *  - Emoji flags render as plain two-letter country-code TEXT on Windows,
 *    not as flags (no flag glyphs in Windows' emoji font) — and Windows/
 *    Chrome is this app's primary target platform.
 *  - An external image asset would be a second network path in an app whose
 *    whole promise is "nothing after the model download" (CLAUDE.md). An
 *    inline SVG in the same bundle costs nothing at runtime and needs no
 *    CSP allowance.
 * Kept deliberately minimal — flat stripes/fields, no crests or coats of
 * arms — both because that IS this device's visual language (theme.css §1:
 * no gradients, no material imitation, no icon library) and because
 * anything finer is unreadable at the ~16px this renders at.
 *
 * Open interpretation call (not specified by the plan, flagged in the U4
 * report): `en`'s flag is England's St George's Cross, not the Union Jack.
 * The label next to it is "English" (a language), not "United Kingdom" (a
 * state) — a plain red-on-white cross is simpler to draw correctly at this
 * size AND sidesteps picking one single anglophone country to stand in for
 * the language.
 */
import { setLocale, t, type Locale } from '../i18n';
import { useLocale } from '../i18n/useLocale';
import { SUPPORTED } from '../i18n/locale';
import { writeStoredLocale } from '../i18n/localeStorage';

/**
 * One shared `viewBox` (3∶2, matching every other flag) so no case needs
 * its own scale — the numbers below were chosen to divide evenly into it
 * (30 / 3 = 10, 18 / 3 = 6, 18 / 4 = 4.5).
 */
function Flag({ locale }: { locale: Locale }) {
  const svgProps = {
    viewBox: '0 0 30 18',
    width: 20,
    height: 12,
    'aria-hidden': true,
    focusable: false,
  } as const;
  switch (locale) {
    case 'de':
      return (
        <svg {...svgProps}>
          <rect width="30" height="6" fill="#000000" />
          <rect y="6" width="30" height="6" fill="#DD0000" />
          <rect y="12" width="30" height="6" fill="#FFCE00" />
        </svg>
      );
    case 'en':
      return (
        <svg {...svgProps}>
          <rect width="30" height="18" fill="#FFFFFF" />
          <rect x="12" width="6" height="18" fill="#CE1124" />
          <rect y="6" width="30" height="6" fill="#CE1124" />
        </svg>
      );
    case 'it':
      return (
        <svg {...svgProps}>
          <rect width="10" height="18" fill="#009246" />
          <rect x="10" width="10" height="18" fill="#FFFFFF" />
          <rect x="20" width="10" height="18" fill="#CE2B37" />
        </svg>
      );
    case 'fr':
      return (
        <svg {...svgProps}>
          <rect width="10" height="18" fill="#0055A4" />
          <rect x="10" width="10" height="18" fill="#FFFFFF" />
          <rect x="20" width="10" height="18" fill="#EF4135" />
        </svg>
      );
    case 'es':
      return (
        <svg {...svgProps}>
          <rect width="30" height="4.5" fill="#AA151B" />
          <rect y="4.5" width="30" height="9" fill="#F1BF00" />
          <rect y="13.5" width="30" height="4.5" fill="#AA151B" />
        </svg>
      );
  }
}

export function LocaleSwitch() {
  const locale = useLocale();
  const label = t('localeSwitch.label');

  const handleChange = (next: Locale) => {
    setLocale(next);
    writeStoredLocale(next);
  };

  return (
    <label className="locale-switch" title={label}>
      <Flag locale={locale} />
      <select
        className="locale-switch__control"
        value={locale}
        aria-label={label}
        onChange={(event) => handleChange(event.target.value as Locale)}
      >
        {/* Owner feedback (2026-07-26): the two-letter code, not the spelled-out
            language name — this is device lettering in the housing's corner
            (`DE`/`EN`/`IT`/…, like `REC` and `IN`), and five full names made the
            control several times wider than the flag beside it. The codes are
            the `Locale` values themselves, so there is nothing to translate and
            nothing that can drift out of sync with `SUPPORTED`. */}
        {SUPPORTED.map((entry) => (
          <option key={entry} value={entry}>
            {entry.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}
