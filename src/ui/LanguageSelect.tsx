/**
 * The transcription-language dropdown (hardware test 01, owner decision):
 * shown on all three landing screens (record setup / meeting / import) once
 * the folder is chosen — the same "after Speicherort" placement on each, so
 * the three landings keep reading as one device.
 *
 * 'de' is the default, and there is deliberately NO "automatic" option
 * (owner decision after the file-import hardware test): transformers.js has
 * no language detection — a null language hard-defaults to the <|en|> token,
 * so "auto" would silently translate German audio to English (see
 * whisperEngine.ts). The engine still maps a stray 'auto' defensively.
 *
 * One shared value lives in App (session-wide, deliberately NOT reset per
 * recording — whoever records English meetings records the next one in
 * English too). A native <select>, no custom dropdown machinery (YAGNI).
 */
import { t, type StringKey } from '../i18n';

export type TranscriptionLanguage = 'de' | 'en' | 'it' | 'fr' | 'es';

/**
 * What the selector offers, paired with the i18n key for its label — the
 * codes are Whisper language tokens. Labels are resolved via `t()` inside
 * the component (render time), NOT at module scope: `main.tsx` sets the
 * locale only after its static imports (this module among them) have
 * already run, so a module-level `t()` call would freeze on whatever locale
 * was active before that (KTD14, same reasoning as `DemoLoop.tsx`'s
 * `demoLines`/`ModeToggle.tsx`'s `ALL_OPTION_KEYS`). Every entry is a
 * language name spoken in its own language — kept byte-identical across all
 * five locale tables, never actually translated.
 */
const LANGUAGE_OPTIONS: readonly { value: TranscriptionLanguage; labelKey: StringKey }[] = [
  { value: 'de', labelKey: 'language.de' },
  { value: 'en', labelKey: 'language.en' },
  { value: 'it', labelKey: 'language.it' },
  { value: 'fr', labelKey: 'language.fr' },
  { value: 'es', labelKey: 'language.es' },
] as const;

export function LanguageSelect({
  value,
  onChange,
}: {
  value: TranscriptionLanguage;
  onChange: (language: TranscriptionLanguage) => void;
}) {
  return (
    <label className="language-select">
      {/* KTD14: sharpened from "Sprache" — U4 adds a separate UI-language
          switcher, and this dropdown picks the RECORDING's language, not the
          UI's, so the two must read as different things on screen. */}
      <span className="language-select__label">{t('language.label')}</span>
      <select
        className="language-select__control"
        value={value}
        onChange={(event) => onChange(event.target.value as TranscriptionLanguage)}
      >
        {LANGUAGE_OPTIONS.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {t(entry.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}
