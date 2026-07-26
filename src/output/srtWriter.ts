/**
 * U10 (R9): turns finalized transcript segments into the `.srt` output —
 * numbered, timestamped cues that stay in sync with the parallel `.webm`
 * recording, appended incrementally through the U9 `fileSink` as each
 * segment finalizes.
 *
 * Same pure-formatting/thin-I/O split as `txtWriter.ts`: `formatSrtCue`
 * (one cue) and `formatSrt` (a whole sequence, the "write everything at
 * once" reference the append/full-write equivalence test checks against)
 * are pure and fully unit-testable without any `AppendableFile`; `SrtWriter`
 * is the thin stateful wrapper that assigns the next cue number and pushes
 * the UTF-8 result through an `AppendableFile`.
 *
 * Timestamps: `segment.startMs`/`endMs` are U5's *global* wall-clock range
 * (`transcriptChannel.ts`'s `final` message, `GlobalClock` in
 * `segmentation.ts`) — continuous across a sub-session reset, never the
 * model's own per-sub-session clock. This file only formats them; it does
 * not (and must not) recompute or re-derive timing — see `segmentation.ts`
 * for why the global clock is already reset-safe and monotonic by
 * construction. Cue numbering (1, 2, 3, ...) is this writer's own concern,
 * independent of any store-assigned `seq`.
 *
 * Segment type: a narrowed `Pick` of `TranscriptSegment`
 * (`ui/transcriptStore.ts`), same DRY rationale as `txtWriter.ts`.
 */
import type { TranscriptSegment } from '../ui/transcriptStore';
import type { AppendableFile } from './fileSink';

/** Everything `srtWriter.ts` needs from a finalized segment. */
export type SrtSegment = Pick<TranscriptSegment, 'text' | 'startMs' | 'endMs'>;

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * Formats a global-clock millisecond offset as an SRT timestamp:
 * `HH:MM:SS,mmm` — zero-padded, comma as the decimal separator (SRT's exact
 * required format, not the ISO/`.` variant). Negative input clamps to 0
 * (defensive only; U5's `GlobalClock` never produces negative offsets).
 */
export function formatSrtTimestamp(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/**
 * Formats one complete SRT cue block: cue number, `start --> end` timestamp
 * line, the segment's text, then the blank line that separates cues (SRT's
 * required trailing blank line — each cue's own, so simply concatenating
 * consecutive cues in order already yields a valid `.srt`).
 */
export function formatSrtCue(cueNumber: number, segment: SrtSegment): string {
  const timing = `${formatSrtTimestamp(segment.startMs)} --> ${formatSrtTimestamp(segment.endMs)}`;
  return `${cueNumber}\n${timing}\n${segment.text.trim()}\n\n`;
}

/**
 * Pure reference formatting: the whole `.srt` file's content if every
 * segment were written at once, in order, numbered 1..N. `SrtWriter`'s
 * incremental `writeSegment()` calls must reproduce this exact string when
 * concatenated — the plan's test scenario 4 (append/full-write
 * equivalence).
 */
export function formatSrt(segments: readonly SrtSegment[]): string {
  return segments.map((segment, index) => formatSrtCue(index + 1, segment)).join('');
}

const encoder = new TextEncoder();

/**
 * Thin I/O wrapper over one `.srt` `AppendableFile` (U9): opens once at
 * session start (by the caller), then `writeSegment()` once per finalized
 * segment, in arrival order (cue numbers are assigned in call order, not
 * derived from the segment's own timestamps).
 */
export class SrtWriter {
  readonly #file: AppendableFile;
  #nextCueNumber = 1;

  constructor(file: AppendableFile) {
    this.#file = file;
  }

  /** Appends the next numbered cue for one finalized segment. */
  async writeSegment(segment: SrtSegment): Promise<void> {
    const cue = formatSrtCue(this.#nextCueNumber, segment);
    this.#nextCueNumber += 1;
    await this.#file.append(encoder.encode(cue));
  }

  /** Releases the underlying file. Safe to call once the session is done. */
  async close(): Promise<void> {
    await this.#file.close();
  }
}
