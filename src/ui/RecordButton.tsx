/**
 * U12 §5 — the record button, the spec's "kritisches Bauteil". It must
 * *punch through* the display frame, not sit on top of it: the outer element
 * is a `--bg`-coloured circle absolutely positioned at the bottom-centre of
 * the display and overlapping it by half, so the black frame reads as cut
 * away behind it. Inside sits a 3px ink ring, and inside that the state
 * symbol. All geometry/colour lives in theme.css (`.record-button*`); this
 * component only owns the structure and the symbol swap.
 *
 * **Owner feedback (2026-07-26): play/stop, not dot/square.** §5's resting
 * symbol was a black disc with a red DOT — the universal "armed to record"
 * mark, but on a device whose whole point is one button it said nothing
 * about what pressing it does. The red dot inside the disc is now a red PLAY
 * triangle; the recording symbol stays §5's red rounded square, which
 * already reads as stop. Two marks, one pair, no wording needed.
 *
 * `processing` shows the stop square WITHOUT `recording` being true: while an
 * imported file is being decoded/transcribed the device is busy with audio,
 * and a play triangle there would invite a press that does nothing (the
 * parent keeps the button `disabled` throughout — there is no abort for an
 * import, and this prop does not add one). The a11y state stays honest:
 * `aria-pressed`/`aria-label` follow `recording` alone.
 *
 * Spacebar start/stop and disabled handling live in the parent (App.tsx); the
 * button is a plain <button> so it inherits the global focus ring (§9).
 */
import { t } from '../i18n';

export interface RecordButtonProps {
  recording: boolean;
  /** Audio is being worked on without a recording running (import decode/transcribe) — shows the stop symbol, changes nothing else. */
  processing?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function RecordButton({ recording, processing = false, disabled = false, onClick }: RecordButtonProps) {
  return (
    <button
      type="button"
      className="record-button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={recording ? t('record.stopLabel') : t('record.startLabel')}
    >
      <span className="record-button__ring">
        {recording || processing ? (
          // Läuft: rotes abgerundetes Quadrat = Stopp (§5)
          <span className="record-button__square" />
        ) : (
          // Ruhe: schwarzer Kreis mit rotem Play-Dreieck darin
          <span className="record-button__dot-outer">
            <span className="record-button__play" />
          </span>
        )}
      </span>
    </button>
  );
}
