/**
 * Moved here from `src/diarization/align.ts` (Flagge 6a): the function body
 * is a pure `t()` wrapper, and its callers span both the output layer
 * (`src/output/speakerTranscript.ts`) and the UI layer
 * (`src/ui/SpeakerView.tsx`) — the output layer must not import from `ui/`,
 * but both may import from `i18n/`. So this belongs in the i18n layer, not
 * `ui/format.ts`. The diarization domain no longer imports any presentation
 * concern.
 */
import { t } from './index';

/**
 * Human-facing 1-based label for a 0-based speaker index (`0` → "Sprecher
 * 1"/"Speaker 1"). Runs on the main thread, not in the diarization worker
 * (callers: `src/output/speakerTranscript.ts`, `src/ui/SpeakerView.tsx`),
 * so reading the UI locale here is safe — no second locale resolution is
 * needed in a worker context (the label follows the UI language all the way
 * into the exported speaker transcript).
 */
export function speakerLabel(speaker: number): string {
  return t('speaker.label', { n: speaker + 1 });
}
