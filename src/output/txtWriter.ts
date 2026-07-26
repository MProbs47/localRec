/**
 * U10 (R9): turns finalized transcript segments into the `.txt` output —
 * "durchgehender Lesetext ohne Segment-Artefakte" (continuous reading text,
 * no visible segment markers/indices), appended incrementally through the
 * U9 `fileSink` as each segment finalizes.
 *
 * Split the same way `segmentation.ts`/`progress.ts` split pure decision
 * logic from I/O: `formatTranscriptText` is the pure "write everything at
 * once" reference the plan's required append/full-write equivalence test
 * checks against; `formatTxtAppend` is the pure per-call incremental
 * counterpart (same joining rule, but only the *new* bytes one more
 * `TxtWriter.writeSegment()` call must emit, given whether anything has
 * already been written). `TxtWriter` is the thin stateful wrapper that
 * calls `formatTxtAppend` and pushes the UTF-8 result through an
 * `AppendableFile` (U9) — it owns no formatting decisions itself.
 *
 * Joining rule: segments are speech utterances, not sentences, so a single
 * space between them (never a per-segment newline, never a visible index)
 * is what keeps the result reading as one continuous paragraph rather than
 * a transcript log. Each segment's text is trimmed before joining so
 * leading/trailing model whitespace can't introduce doubled spaces.
 *
 * Segment type: a narrowed `Pick` of `TranscriptSegment`
 * (`ui/transcriptStore.ts`) rather than a competing shape (DRY, per plan) —
 * only `text` is needed here, `startMs`/`endMs`/`speaker` are irrelevant to
 * plain-text output.
 */
import type { TranscriptSegment } from '../ui/transcriptStore';
import type { AppendableFile } from './fileSink';

/** Everything `txtWriter.ts` needs from a finalized segment. */
export type TxtSegment = Pick<TranscriptSegment, 'text'>;

/**
 * Pure reference formatting: the whole `.txt` file's content if every
 * segment were written at once, in order. `TxtWriter`'s incremental
 * `append()` calls must reproduce this exact string when concatenated —
 * that equivalence is what the plan's test scenario 4 checks. Segments
 * with only-whitespace text are dropped so they can't introduce doubled
 * spaces or leading/trailing padding.
 */
export function formatTranscriptText(segments: readonly TxtSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(' ');
}

/**
 * The exact chunk one more `TxtWriter.writeSegment()` call must append,
 * given `hasWrittenAny` (whether any earlier segment already produced
 * output for this file). Empty string means "append nothing" — an
 * only-whitespace segment. Applying this in order over a segment sequence,
 * starting from `hasWrittenAny = false`, and concatenating the results
 * reproduces `formatTranscriptText(segments)` exactly.
 */
export function formatTxtAppend(segment: TxtSegment, hasWrittenAny: boolean): string {
  const trimmed = segment.text.trim();
  if (trimmed.length === 0) return '';
  return hasWrittenAny ? ` ${trimmed}` : trimmed;
}

const encoder = new TextEncoder();

/**
 * Thin I/O wrapper over one `.txt` `AppendableFile` (U9): opens once at
 * session start (by the caller — this class doesn't call `openFile`
 * itself), then `writeSegment()` once per finalized segment. Holds exactly
 * the one bit of state `formatTxtAppend` needs (`#hasWrittenAny`); all
 * joining logic lives in the pure functions above.
 */
export class TxtWriter {
  readonly #file: AppendableFile;
  #hasWrittenAny = false;

  constructor(file: AppendableFile) {
    this.#file = file;
  }

  /** Appends one finalized segment's contribution to the continuous text. No-op for an only-whitespace segment. */
  async writeSegment(segment: TxtSegment): Promise<void> {
    const chunk = formatTxtAppend(segment, this.#hasWrittenAny);
    if (chunk.length === 0) return;
    this.#hasWrittenAny = true;
    await this.#file.append(encoder.encode(chunk));
  }

  /** Releases the underlying file. Safe to call once the session is done. */
  async close(): Promise<void> {
    await this.#file.close();
  }
}
