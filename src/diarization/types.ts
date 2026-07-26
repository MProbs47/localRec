/**
 * Shared diarization domain types (Phase D). Kept in one small module because
 * the pipeline (`diarize.ts`), the alignment core (`align.ts`), and the
 * speaker-aware writers (`output/*`) all speak in the same "who spoke when"
 * vocabulary, and none of them should own it.
 */

/** One stretch of audio attributed to a single global speaker, in whole-recording milliseconds. */
export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  /** 0-based global speaker index (see `clustering.ts`'s first-appearance labelling). */
  speaker: number;
}

/**
 * The whole-recording speaker timeline: turns sorted by `startMs`, adjacent
 * same-speaker turns already merged (`diarize.ts`). The output U17 aligns the
 * transcript against.
 */
export type SpeakerTimeline = SpeakerTurn[];
