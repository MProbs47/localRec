/**
 * U19 (IM-2) + Plan 003 U3/U4: the landing-page switch between the input
 * sources — "Lokale Aufnahme" (the U12 one-button mic path), "Datei laden"
 * (U19 import) and, on capable browsers, "Online Meeting" (Plan 003's
 * mic+system-audio meeting mode). Purely presentational and controlled —
 * like `RecordButton`/`VuMeter`, it holds no state of its own; `App.tsx`
 * owns the `mode` value and only renders this component while `deviceState`
 * is `idle`/`ready` (before/between recordings — never mid-recording, never
 * mid-download; see `App.tsx`'s wiring comment).
 *
 * The three names name the SOURCE directly, so the user reads what each does
 * without a legend: "Lokale Aufnahme" = only me (mic), "Online Meeting" = me
 * plus the others (mic + system audio), "Datei laden" = an existing file.
 *
 * **"Online Meeting" is feature-gated (KTD-M3).** System-/tab-audio capture
 * exists only on Chromium desktop, so the option is offered only when
 * `App.tsx` passes `meetingAvailable` (i.e. `canCaptureSystemAudio()`); where
 * it's false the toggle stays a clean two-way switch and the whole app is
 * fully usable — the meeting mode is simply invisible, never a dead/disabled
 * button (graceful degradation, never a blocking error).
 *
 * **Net-new element — not in the owner's device spec.**
 * That spec (§2's tokens, §3-§8's states) predates the file-import track
 * (Phase E, added 2026-07-23) and has no opinion on a mode switch. This
 * component reuses the spec's existing visual language (mono uppercase
 * labels, `--ink` hairline border, no third colour, no icon library — the
 * same restraint U12's `first-run__action`/`recovery__option` buttons use)
 * rather than inventing a new visual idiom, but its exact placement/sizing
 * is a functional placeholder, the same posture the original first-run
 * screen (now `FirstRunScreens.tsx`) shipped with before U12 gave it real
 * styling. **Flagged for the project owner's
 * design pass**, not a final look.
 *
 * **Accessibility.** `role="radiogroup"` + `role="radio"` buttons is the
 * standard exclusive-choice pattern (mirrors a native `<input type="radio">`
 * group's semantics for a screen reader without actually using radio inputs,
 * which can't be styled as a segmented control without fighting native UA
 * chrome). Plain `<button>` elements are already keyboard-operable via Tab +
 * Enter/Space with no extra wiring; ArrowLeft/ArrowRight additionally move the
 * selection across the currently-offered options (two or three), the
 * conventional roving behavior for a `radiogroup` once it has focus.
 */
import type { KeyboardEvent } from 'react';
import { t, type StringKey } from '../i18n';

export type Mode = 'record' | 'import' | 'meeting';

export interface ModeToggleProps {
  value: Mode;
  onChange: (mode: Mode) => void;
  /**
   * Whether the "Online Meeting" (system-audio) mode is offered — `App.tsx`
   * passes `canCaptureSystemAudio()` (KTD-M3). Hidden entirely where false, so
   * the toggle stays a clean two-way switch on non-Chromium/desktop; defaults
   * to `false` so a caller that hasn't feature-detected never shows a mode the
   * environment can't fulfill.
   */
  meetingAvailable?: boolean;
}

// Keys, not labels, at module scope: `main.tsx` sets the locale only after
// its static imports (this module among them) have already run, so a
// module-level `t()` call would freeze on whatever locale was active before
// that. Labels are resolved via `t()` inside the component, at render time.
const ALL_OPTION_KEYS: { mode: Mode; labelKey: StringKey }[] = [
  { mode: 'record', labelKey: 'mode.record' },
  { mode: 'import', labelKey: 'mode.import' },
  { mode: 'meeting', labelKey: 'mode.meeting' },
];

export function ModeToggle({ value, onChange, meetingAvailable = false }: ModeToggleProps) {
  const optionKeys = meetingAvailable ? ALL_OPTION_KEYS : ALL_OPTION_KEYS.filter((option) => option.mode !== 'meeting');
  const options = optionKeys.map((option) => ({ mode: option.mode, label: t(option.labelKey) }));

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const currentIndex = options.findIndex((option) => option.mode === value);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + step + options.length) % options.length;
    onChange(options[nextIndex].mode);
  };

  return (
    <div className="mode-toggle" role="radiogroup" aria-label={t('mode.ariaLabel')} onKeyDown={handleKeyDown}>
      {options.map((option) => {
        const active = option.mode === value;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? 'mode-toggle__option mode-toggle__option--active' : 'mode-toggle__option'}
            onClick={() => onChange(option.mode)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
